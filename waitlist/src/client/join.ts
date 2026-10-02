// S7 waitlist ticket. Same /api/join request as site/ (no role on the wire); the browser uses the server's own
// normalizeHandle for instant feedback, the server stays authoritative. Turnstile loads lazily (about 1.5
// viewports before the form, or on Join / focus) and is reset after every submit (each token works once).
import { normalizeHandle, type Channel } from '../server/waitlist.ts';
import { waitlist as Wl, nav } from '../copy/en.ts';
import { motionOn } from './motion.ts';
import { state, on, set } from './store.ts';

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
  const handle = form.querySelector<HTMLInputElement>('#wl-handle')!;
  const field = handle.closest<HTMLElement>('.field')!;
  const terms = form.querySelector<HTMLElement>('[data-terms]')!;
  const validText = form.querySelector<HTMLElement>('[data-valid-text]')!;
  const consent = form.querySelector<HTMLInputElement>('#wl-consent')!;
  const juris = form.querySelector<HTMLInputElement>('#wl-jurisdiction')!;
  const statusEl = form.querySelector<HTMLElement>('[data-status]')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
  const cfEl = form.querySelector<HTMLElement>('[data-cf]')!;
  const errors = JSON.parse(form.dataset.errors ?? '{}') as Record<string, string>;
  const valid = JSON.parse(form.dataset.valid ?? '{}') as Record<Channel, string>;
  const doors = JSON.parse(form.dataset.doors ?? '{}') as Record<'trader' | 'underwriter', { title: string; line: string }>;
  const doorTitle = section.querySelector<HTMLElement>('[data-door-title]')!;
  const doorLine = section.querySelector<HTMLElement>('[data-door-line]')!;
  const doorInputs = [...section.querySelectorAll<HTMLInputElement>('[data-door]')];
  let widgetId: string | undefined;
  let captchaRequested = false;
  let blurred = false;

  // ---- doors (wording only) ----
  function door(role: 'trader' | 'underwriter') {
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
  function fail(key: string, focusEl?: HTMLElement) {
    ticket.dataset.state = 'error';
    say(errors[key] ?? errors.generic, 'error');
    shake();
    if (focusEl) {
      focusEl.setAttribute('aria-invalid', 'true');
      if (focusEl === handle) field.dataset.valid = 'n';
      focusEl.focus();
    }
  }
  function busy(on: boolean) {
    form.setAttribute('aria-busy', String(on));
    handle.readOnly = on;
    submit.disabled = on;
    const label = submit.querySelector('.cta-label')!;
    label.textContent = on ? Wl.sending : state.joined ? nav.joined : Wl.submit;
    if (on) ticket.dataset.state = 'submitting';
  }
  function resetCaptcha() {
    try {
      window.turnstile?.reset(widgetId);
    } catch {
      // widget not loaded
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;
    blurred = true;
    loadCaptcha();
    const ch = channel();
    const raw = handle.value;
    for (const el of [handle, consent, juris]) el.removeAttribute('aria-invalid');
    // same order as the server: handle, consent, jurisdiction
    if (!normalizeHandle(raw, ch)) return fail('handle', handle);
    if (!consent.checked) return fail('consent', consent);
    if (!juris.checked) return fail('jurisdiction', juris);
    const token =
      (widgetId !== undefined ? window.turnstile?.getResponse(widgetId) : undefined) ??
      String(new FormData(form).get('cf-turnstile-response') ?? '');
    busy(true);
    say('', '');
    try {
      const r = await fetch(form.dataset.endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: raw,
          channel: ch,
          consent: true,
          consentVersion: String(new FormData(form).get('consentVersion') ?? ''),
          jurisdiction: true,
          turnstileToken: token ?? '',
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      busy(false);
      if (r.ok && j.ok) {
        ticket.dataset.state = 'success';
        say(form.dataset.success ?? '', 'ok');
        set('joined', true);
      } else {
        const err = j.error ?? 'generic';
        const target = err === 'handle' ? handle : err === 'consent' ? consent : err === 'jurisdiction' ? juris : undefined;
        fail(['handle', 'consent', 'jurisdiction', 'captcha', 'rate'].includes(err) ? err : 'generic', target);
      }
    } catch {
      busy(false);
      fail('generic');
    } finally {
      resetCaptcha();
    }
  });

  door(state.role);
  feedback();

  return {
    focusForm() {
      loadCaptcha();
      handle.focus({ preventScroll: true });
      if (motionOn()) {
        ticket.classList.remove('shake');
        void ticket.offsetWidth;
        ticket.classList.add('shake');
      }
    },
    loadCaptcha,
  };
}
