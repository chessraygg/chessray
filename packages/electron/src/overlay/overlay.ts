// Thin Electron bootstrap. The full mount logic + panel HTML/CSS live in
// @chessray/overlay-ui; we just hand the preload-exposed window.chessRay
// to mountOverlay() and let it do the rest.

import { mountOverlay } from '@chessray/overlay-ui';
// Electron's overlay window owns its document, so loading panel.css's
// global rules (body{overflow:hidden}, * resets) is fine here.
import '@chessray/overlay-ui/src/panel.css';

mountOverlay(window.chessRay);
