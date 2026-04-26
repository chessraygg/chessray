// Thin Electron bootstrap. The full mount logic + panel HTML/CSS live in
// @chessray/overlay-ui; we just hand the preload-exposed window.chessRay
// to mountOverlay() and let it do the rest.

import { mountOverlay } from '@chessray/overlay-ui';

mountOverlay(window.chessRay);
