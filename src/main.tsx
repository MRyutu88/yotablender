import { render } from 'preact';
import { Viewport } from './render/viewport';
import { App } from './app/app';
import { GestureRecognizer } from './input/gestures';
import { InputController, installKeyboard } from './input/controller';
import { Ui } from './ui/Ui';
import * as S from './app/state';
import { getSetting } from './app/storage';
import './ui/styles.css';

// Capture errors for the on-screen log (no PC DevTools needed on the phone).
window.addEventListener('error', (e) => S.logError(e.message));
window.addEventListener('unhandledrejection', (e) => S.logError(String(e.reason)));

const root = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.className = 'viewport';
root.appendChild(canvas);
const uiRoot = document.createElement('div');
uiRoot.className = 'ui-root';
root.appendChild(uiRoot);

const vp = new Viewport(canvas);
const app = new App(vp);
new GestureRecognizer(canvas, new InputController(app));
installKeyboard(app);

const resize = () => vp.resize(root.clientWidth, root.clientHeight);
new ResizeObserver(resize).observe(root);
resize();

// "Install app" button (Android Chrome fires beforeinstallprompt when installable).
type InstallEvent = Event & { prompt: () => Promise<void> };
let installPrompt: (() => void) | null = null;
const draw = () => render(<Ui app={app} installPrompt={installPrompt} />, uiRoot);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  const ev = e as InstallEvent;
  installPrompt = () => {
    void ev.prompt();
    installPrompt = null;
    draw();
  };
  draw();
});

draw();
void app.init().then(async () => {
  if (!(await getSetting('seenHelp', false))) S.sheet.value = 'help';
});

// Service worker: precaches the app for offline use; shows "Reload" when an update is ready.
if (import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    const update = registerSW({
      onNeedRefresh: () => (S.updateReady.value = true),
      onOfflineReady: () => S.toast('Ready to work offline'),
    });
    window.addEventListener('yb-apply-update', () => void update(true));
  });
}

// Debug handle for development in desktop Chrome.
(window as unknown as { yb: App; ybState: typeof S }).yb = app;
(window as unknown as { ybState: typeof S }).ybState = S;
