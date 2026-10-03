// S7 waitlist ticket. The /api/join request is site/'s plus a required `email`; `telegram` and `x` are each optional (no role
// on the wire). The browser uses the server's own normalizeEmail / normalizeHandle for instant feedback; the
// server stays authoritative. Turnstile loads lazily (about 1.5
// viewports before the form, or on Join / focus) and is reset after every failed submit (each token works
// once); after a success it is parked until the visitor reopens the form.
import { normalizeEmail, optionalHandle, type Channel } from '../server/waitlist.ts';
import { waitlist as Wl } from '../copy/en.ts';
import { motionOn } from './motion.ts';
import { set } from './store.ts';

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
  const tg = form.querySelector<HTMLInputElement>('#wl-telegram')!;
  const xh = form.querySelector<HTMLInputElement>('#wl-x')!;
  const handles: [Channel, HTMLInputElement][] = [
    ['telegram', tg],
    ['x', xh],
  ];
  const moreToggle = form.querySelector<HTMLButtonElement>('[data-more-toggle]')!;
  const moreBody = form.querySelector<HTMLElement>('[data-more-body]')!;
  const consent = form.querySelector<HTMLInputElement>('#wl-consent')!;
  const juris = form.querySelector<HTMLInputElement>('#wl-jurisdiction')!;
  const statusEl = section.querySelector<HTMLElement>('[data-status]')!;
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
  const cfEl = form.querySelector<HTMLElement>('[data-cf]')!;
  const issued = section.querySelector<HTMLElement>('[data-issued]')!;
  const again = section.querySelector<HTMLButtonElement>('[data-again]')!;
  const errors = JSON.parse(form.dataset.errors ?? '{}') as Record<string, string>;
  let widgetId: string | undefined;
  let captchaRequested = false;
  let blurred = false;

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
          // the managed widget stays invisible unless Cloudflare needs the visitor to click (server check unchanged)
          appearance: 'interaction-only',
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
  const fieldOf = (el: HTMLInputElement) => el.closest<HTMLElement>('.field')!;
  function feedback() {
    for (const [ch, el] of handles) {
      const v = optionalHandle(el.value, ch);
      if (v) {
        fieldOf(el).dataset.valid = 'y';
        el.removeAttribute('aria-invalid');
      } else fieldOf(el).dataset.valid = blurred && v === false ? 'n' : '';
    }
  }

  // ---- the optional Telegram/X block, collapsed behind a disclosure button ----
  /** Opens or closes the block; the height animates (240 ms) unless motion is off (reduced motion, paused). */
  let moreAnim: Animation | null = null;
  function setMore(open: boolean) {
    if ((moreToggle.getAttribute('aria-expanded') === 'true') === open && moreBody.hidden === !open) return;
    moreToggle.setAttribute('aria-expanded', String(open));
    moreAnim?.cancel();
    moreAnim = null;
    if (!motionOn() || typeof moreBody.animate !== 'function') {
      moreBody.hidden = !open;
      return;
    }
    moreBody.hidden = false;
    const h = moreBody.scrollHeight;
    moreBody.classList.add('sizing');
    const a = moreBody.animate(
      [{ height: `${open ? 0 : h}px` }, { height: `${open ? h : 0}px` }],
      { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    moreAnim = a;
    a.onfinish = () => {
      moreBody.classList.remove('sizing');
      if (!open) moreBody.hidden = true;
      moreAnim = null;
    };
    a.oncancel = () => moreBody.classList.remove('sizing');
  }
  moreToggle.addEventListener('click', () => {
    const open = moreToggle.getAttribute('aria-expanded') !== 'true';
    setMore(open);
    if (open) tg.focus();
  });
  email.addEventListener('input', () => {
    email.removeAttribute('aria-invalid');
    clearInline(email);
  });
  for (const [, el] of handles) {
    el.addEventListener('input', feedback);
    el.addEventListener('input', () => clearInline(el));
    el.addEventListener('blur', () => {
      blurred = true;
      feedback();
    });
  }
  form.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.type === 'checkbox' && t.checked) {
      t.removeAttribute('aria-invalid');
      clearInline(t);
    }
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
  // ---- inline errors: the message sits next to its field, wired with aria-describedby ----
  const errSlot = (name: string) => form.querySelector<HTMLElement>(`[data-error="${name}"]`);
  const fieldName = (el: HTMLElement) => el.id.replace(/^wl-/, '');
  function clearInline(el?: HTMLElement) {
    for (const slot of form.querySelectorAll<HTMLElement>('[data-error]')) {
      if (el && slot !== errSlot(fieldName(el))) continue;
      slot.hidden = true;
      slot.textContent = '';
      const input = form.querySelector<HTMLElement>(`#wl-${slot.dataset.error}`);
      if (input) {
        const rest = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((t) => t && t !== slot.id);
        if (rest.length) input.setAttribute('aria-describedby', rest.join(' '));
        else input.removeAttribute('aria-describedby');
      }
    }
  }
  function showInline(el: HTMLElement, msg: string): boolean {
    const slot = errSlot(fieldName(el));
    if (!slot) return false;
    slot.textContent = msg;
    slot.hidden = false;
    const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    if (!ids.includes(slot.id)) el.setAttribute('aria-describedby', [slot.id, ...ids].join(' '));
    return true;
  }

  /** An error: the message next to the field at fault (or in the reserved status slot when no field is at fault:
   *  captcha, rate, region, network), a shake, and focus on the field, or on the status line, so keyboard users
   *  keep their place. */
  function fail(key: string, focusEl?: HTMLElement) {
    ticket.dataset.state = 'error';
    clearInline();
    const msg = errors[key] ?? errors.generic;
    if (focusEl && showInline(focusEl, msg)) say('', '');
    else say(msg, 'error');
    shake();
    if (focusEl) {
      const isHandle = focusEl === tg || focusEl === xh;
      if (isHandle) setMore(true);
      focusEl.setAttribute('aria-invalid', 'true');
      if (isHandle) fieldOf(focusEl as HTMLInputElement).dataset.valid = 'n';
      focusEl.focus();
    } else statusEl.focus({ preventScroll: false });
  }
  /** Sending: aria-busy, read-only fields; the submit keeps focus (aria-disabled, not disabled). */
  function busy(on: boolean) {
    form.setAttribute('aria-busy', String(on));
    for (const [, el] of handles) el.readOnly = on;
    email.readOnly = on;
    for (const el of form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) el.disabled = on;
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
  function issue(mail: string, telegram: string | null, x: string | null) {
    const v = (k: string) => issued.querySelector<HTMLElement>(`[data-i="${k}"]`)!;
    v('email').textContent = mail;
    v('telegram').textContent = telegram ? `@${telegram}` : Wl.issued.none;
    v('x').textContent = x ? `@${x}` : Wl.issued.none;
    issued.hidden = false;
    ticket.dataset.state = 'success';
    // the ticket's top (the stamp) comes into view on narrow screens
    const r = ticket.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight * 0.5)
      ticket.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
    issued.focus({ preventScroll: true });
  }
  again.addEventListener('click', () => {
    issued.hidden = true;
    ticket.dataset.state = 'idle';
    say('', '');
    clearInline();
    email.value = '';
    tg.value = '';
    xh.value = '';
    setMore(false);
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
    for (const el of [email, tg, xh, consent, juris]) el.removeAttribute('aria-invalid');
    clearInline();
    // the email, then the optional handles, then the two boxes in the order they appear (the server checks each)
    const mail = normalizeEmail(email.value);
    if (!mail) return fail(email.value.trim() ? 'email' : 'emailEmpty', email); // empty and malformed read differently
    const tgName = optionalHandle(tg.value, 'telegram');
    if (tgName === false) return fail('telegram', tg);
    const xName = optionalHandle(xh.value, 'x');
    if (xName === false) return fail('x', xh);
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
          ...(tgName ? { telegram: tg.value } : {}),
          ...(xName ? { x: xh.value } : {}),
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
        issue(mail, tgName, xName);
      } else {
        const err = j.error ?? 'generic';
        const targets: Record<string, HTMLElement> = { email, telegram: tg, x: xh, consent, jurisdiction: juris };
        fail(['email', 'telegram', 'x', 'consent', 'jurisdiction', 'captcha', 'rate', 'region'].includes(err) ? err : 'generic', targets[err]);
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
