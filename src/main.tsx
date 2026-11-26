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
    const applyUpdate = async () => {
      void update(true);
      // Belt and braces: talk to the waiting worker directly too (Workbox only does this when
      // it registered that worker itself), and reload once the new version takes control.
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
      const reg = await navigator.serviceWorker.getRegistration();
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    };
    window.addEventListener('yb-apply-update', () => void applyUpdate());

    // Manual "Check for update" (Settings): ask the server now instead of waiting for the browser's
    // own (sometimes slow) update check, then reload straight into the new version if there is one.
    window.addEventListener('yb-check-update', async () => {
      if (S.checkingUpdate.value) return;
      S.checkingUpdate.value = true;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          S.toast('Updates are not available here', 'error');
          return;
        }
        if (!reg.waiting) {
          await reg.update();
          const installing = reg.installing;
          if (installing && installing.state !== 'installed' && installing.state !== 'activated') {
            await new Promise<void>((resolve) => {
              installing.addEventListener('statechange', () => {
                if (installing.state === 'installed' || installing.state === 'redundant' || installing.state === 'activated') resolve();
              });
            });
          }
        }
        if (reg.waiting) {
          S.updateReady.value = true;
          S.toast('New version found, reloading…');
          await applyUpdate();
        } else {
          S.toast("You're on the latest version");
        }
      } catch {
        S.toast("Couldn't check for updates — are you online?", 'error');
      } finally {
        S.checkingUpdate.value = false;
      }
    });
  });
} else {
  window.addEventListener('yb-check-update', () => S.toast('Updates only work in the installed/production build'));
}

// Debug handle for development in desktop Chrome.
(window as unknown as { yb: App; ybState: typeof S }).yb = app;
(window as unknown as { ybState: typeof S }).ybState = S;
