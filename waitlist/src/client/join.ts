// S7 waitlist ticket. The /api/join request is site/'s plus a required `email`; the handle is optional (no role
// on the wire). The browser uses the server's own normalizeEmail / normalizeHandle for instant feedback; the
// server stays authoritative. Turnstile loads lazily (about 1.5
// viewports before the form, or on Join / focus) and is reset after every failed submit (each token works
// once); after a success it is parked until the visitor reopens the form.
import { normalizeEmail, normalizeHandle, type Channel } from '../server/waitlist.ts';
import { waitlist as Wl } from '../copy/en.ts';
import { motionOn } from './motion.ts';
import { state, on, set } from './store.ts';

const TIMEOUT_MS = 15_000;

type TurnstileApi = {
  render: (el: Element, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  getResponse: (id?: string) => string | undefined;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    numeraTurnstileReady?: () => void;
  }
}

export function mountJoin(section: HTMLElement): { focusForm: () => void; loadCaptcha: () => void } {
  const form = section.querySelector<HTMLFormElement>('[data-form]')!;
  const ticket = section.querySelector<HTMLElement>('[data-ticket]')!;
  const email = form.querySelector<HTMLInputElement>('#wl-email')!;
  const handle = form.querySelector<HTMLInputElement>('#wl-handle')!;
  const field = handle.closest<HTMLElement>('.field')!;
  const terms = form.querySelector<HTMLElement>('[data-terms]')!;
  const validText = form.querySelector<HTMLElement>('[data-valid-text]')!;
  const consent = form.querySelector<HTMLInputElement>('#wl-consent')!;
  const juris = form.querySelector<HTMLInputElement>('#wl-jurisdiction')!;
  const statusEl = section.querySelector<HTMLElement>('[data-status]')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
  const cfEl = form.querySelector<HTMLElement>('[data-cf]')!;
  const issued = section.querySelector<HTMLElement>('[data-issued]')!;
  const again = section.querySelector<HTMLButtonElement>('[data-again]')!;
  const errors = JSON.parse(form.dataset.errors ?? '{}') as Record<string, string>;
  const valid = JSON.parse(form.dataset.valid ?? '{}') as Record<Channel, string>;
  const doors = JSON.parse(form.dataset.doors ?? '{}') as Record<'trader' | 'underwriter', { title: string; line: string }>;
  const doorTitle = section.querySelector<HTMLElement>('[data-door-title]')!;
  const doorLine = section.querySelector<HTMLElement>('[data-door-line]')!;
  const doorInputs = [...section.querySelectorAll<HTMLInputElement>('[data-door]')];
  let widgetId: string | undefined;
  let captchaRequested = false;
  let blurred = false;
  let door_: 'trader' | 'underwriter' = 'trader';

  // ---- doors (wording only) ----
  function door(role: 'trader' | 'underwriter') {
    door_ = role;
    doorTitle.textContent = doors[role].title;
    doorLine.textContent = doors[role].line;
    for (const d of doorInputs) d.checked = d.value === role;
  }
  for (const d of doorInputs) d.addEventListener('change', () => d.checked && door(d.value as 'trader' | 'underwriter'));
  on('role', (s) => door(s.role));

  // ---- Turnstile, lazily ----
  function loadCaptcha() {
    if (captchaRequested) return;
    captchaRequested = true;
    window.numeraTurnstileReady = () => {
      try {
        widgetId = window.turnstile?.render(cfEl, {
          sitekey: form.dataset.sitekey,
          theme: 'dark',
          size: 'flexible',
          language: 'en',
        });
      } catch {
        widgetId = undefined;
      }
    };
    const s = document.createElement('script');
    s.src = `${form.dataset.turnstile}?render=explicit&onload=numeraTurnstileReady`;
    s.async = true;
    s.defer = true;
    document.head.append(s);
  }
  const near = new IntersectionObserver(
    (es) => {
      if (es.some((e) => e.isIntersecting)) {
        near.disconnect();
        loadCaptcha();
      }
    },
    { rootMargin: '150% 0px 150% 0px' },
  );
  near.observe(form);
  form.addEventListener('focusin', loadCaptcha);

  // ---- live feedback ----
  const channel = (): Channel => ((new FormData(form).get('channel') as string) === 'x' ? 'x' : 'telegram');
  function feedback() {
    const raw = handle.value;
    const norm = raw.trim() ? normalizeHandle(raw, channel()) : null;
    terms.textContent = norm ? `${Wl.terms.prefix} ${norm}` : Wl.terms.empty;
    if (norm) {
      field.dataset.valid = 'y';
      validText.textContent = valid[channel()];
      handle.removeAttribute('aria-invalid');
    } else {
      validText.textContent = '';
      field.dataset.valid = blurred && raw.trim() ? 'n' : '';
    }
  }
  handle.addEventListener('input', feedback);
  email.addEventListener('input', () => email.removeAttribute('aria-invalid'));
  handle.addEventListener('blur', () => {
    blurred = true;
    feedback();
  });
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).name === 'channel') feedback();
    const t = e.target as HTMLInputElement;
    if (t.type === 'checkbox' && t.checked) t.removeAttribute('aria-invalid');
  });

  // ---- states ----
  function say(msg: string, kind: 'ok' | 'error' | '') {
    statusEl.textContent = msg;
    statusEl.dataset.state = kind;
  }
  function shake() {
    ticket.classList.remove('shake');
    if (!motionOn()) return;
    void ticket.offsetWidth;
    ticket.classList.add('shake');
  }
  /** An error: the message in the reserved slot, a shake, and focus on the field at fault, or on the
   *  message itself when no field is at fault (captcha, rate, network), so keyboard users keep their place. */
  function fail(key: string, focusEl?: HTMLElement) {
    ticket.dataset.state = 'error';
    say(errors[key] ?? errors.generic, 'error');
    shake();
    if (focusEl) {
      focusEl.setAttribute('aria-invalid', 'true');
      if (focusEl === handle) field.dataset.valid = 'n';
      focusEl.focus();
    } else statusEl.focus({ preventScroll: false });
  }
  /** Sending: aria-busy, read-only fields; the submit keeps focus (aria-disabled, not disabled). */
  function busy(on: boolean) {
    form.setAttribute('aria-busy', String(on));
    handle.readOnly = on;
    email.readOnly = on;
    for (const el of form.querySelectorAll<HTMLInputElement>('input[type=checkbox], input[name=channel]')) el.disabled = on;
    submit.setAttribute('aria-disabled', String(on));
    const label = submit.querySelector('.cta-label')!;
    label.textContent = on ? Wl.sending : Wl.submit;
    if (on) ticket.dataset.state = 'submitting';
  }
  function resetCaptcha() {
    try {
      window.turnstile?.reset(widgetId);
    } catch {
      // widget not loaded
    }
  }
  /** A 200: the fields fold into an issued ticket that shows only what the visitor typed. */
  function issue(mail: string, norm: string | null, ch: Channel | null) {
    const v = (k: string) => issued.querySelector<HTMLElement>(`[data-i="${k}"]`)!;
    v('email').textContent = mail;
    v('handle').textContent = norm ?? Wl.issued.none;
    v('channel').textContent = ch ? (Wl.channel.options.find((o) => o.value === ch)?.label ?? ch) : Wl.issued.none;
    v('door').textContent = doors[door_].title;
    issued.hidden = false;
    ticket.dataset.state = 'success';
    // the ticket's top (strip, seal, stamp) comes into view on narrow screens
    const r = ticket.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight * 0.5)
      ticket.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
    issued.focus({ preventScroll: true });
  }
  again.addEventListener('click', () => {
    issued.hidden = true;
    ticket.dataset.state = 'idle';
    say('', '');
    email.value = '';
    handle.value = '';
    blurred = false;
    feedback();
    resetCaptcha();
    email.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;
    blurred = true;
    loadCaptcha();
    const raw = handle.value;
    const hasHandle = raw.trim() !== '';
    const ch = hasHandle ? channel() : null;
    for (const el of [email, handle, consent, juris]) el.removeAttribute('aria-invalid');
    // the email, then the optional handle, then the two boxes in the order they appear (the server checks each)
    const mail = normalizeEmail(email.value);
    if (!mail) return fail('email', email);
    const norm = ch ? normalizeHandle(raw, ch) : null;
    if (hasHandle && !norm) return fail('handle', handle);
    if (!juris.checked) return fail('jurisdiction', juris);
    if (!consent.checked) return fail('consent', consent);
    const token =
      (widgetId !== undefined ? window.turnstile?.getResponse(widgetId) : undefined) ??
      String(new FormData(form).get('cf-turnstile-response') ?? '');
    busy(true);
    say('', '');
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let ok = false;
    try {
      const r = await fetch(form.dataset.endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.value,
          ...(hasHandle ? { handle: raw, channel: ch } : {}),
          consent: true,
          consentVersion: String(new FormData(form).get('consentVersion') ?? ''),
          jurisdiction: true,
          turnstileToken: token ?? '',
        }),
        signal: ctl.signal,
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      busy(false);
      if (r.ok && j.ok) {
        ok = true;
        say(form.dataset.success ?? '', 'ok');
        set('joined', true);
        issue(mail, norm, ch);
      } else {
        const err = j.error ?? 'generic';
        const target =
          err === 'email' ? email : err === 'handle' || err === 'channel' ? handle : err === 'consent' ? consent : err === 'jurisdiction' ? juris : undefined;
        const key = err === 'channel' ? 'handle' : err;
        fail(['email', 'handle', 'consent', 'jurisdiction', 'captcha', 'rate'].includes(key) ? key : 'generic', target);
      }
    } catch {
      // network error or the 15 s timeout: nothing was confirmed, so the generic message
      busy(false);
      fail('generic');
    } finally {
      clearTimeout(timer);
      if (!ok) resetCaptcha();
    }
  });
  submit.addEventListener('click', (e) => {
    if (submit.getAttribute('aria-disabled') === 'true') e.preventDefault();
  });

  door(state.role);
  feedback();

  return {
    focusForm() {
      loadCaptcha();
      if (ticket.dataset.state === 'success') {
        issued.focus({ preventScroll: true });
        return;
      }
      email.focus({ preventScroll: true });
      if (motionOn()) {
        ticket.classList.remove('shake');
        void ticket.offsetWidth;
        ticket.classList.add('shake');
      }
    },
    loadCaptcha,
  };
}
