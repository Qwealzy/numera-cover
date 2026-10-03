// The SIL Open Font License text of the self-hosted font family, shipped at /licenses/jetbrains-mono-OFL.txt
// (the OFL requires the licence to travel with the font files). Read from the installed package at build time.
import text from '../../../node_modules/@fontsource-variable/jetbrains-mono/LICENSE?raw';

export const GET = () => new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
