// Every page: marks the page script as booted and shows the nav backdrop after 8 px of scroll.
export function bootNav(): void {
  document.documentElement.classList.add('booted');
  const navEl = document.querySelector<HTMLElement>('[data-nav]');
  const onScroll = () => navEl?.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
