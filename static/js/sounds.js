/**
 * sounds.js — Sons d'échiquier (lichess samples).
 *
 * Préchargés au premier user gesture pour respecter les politiques d'autoplay.
 * Volume ajustable, mute automatique en cas d'erreur de chargement.
 */
"use strict";

const Sounds = (() => {
  const URLS = {
    move:    "https://lichess1.org/assets/sound/standard/Move.mp3",
    capture: "https://lichess1.org/assets/sound/standard/Capture.mp3",
    check:   "https://lichess1.org/assets/sound/standard/Check.mp3",
    error:   "https://lichess1.org/assets/sound/standard/Error.mp3",
    correct: "https://lichess1.org/assets/sound/standard/Confirmation.mp3",
  };

  const _cache = {};
  let _enabled = true;
  let _volume  = 0.5;
  let _primed  = false;

  function _load(name) {
    if (_cache[name]) return _cache[name];
    try {
      const a = new Audio(URLS[name]);
      a.preload = "auto";
      a.volume  = _volume;
      _cache[name] = a;
      return a;
    } catch (e) {
      return null;
    }
  }

  /** Précharge tous les sons après une interaction utilisateur. */
  function prime() {
    if (_primed) return;
    _primed = true;
    for (const name of Object.keys(URLS)) _load(name);
  }

  function play(name) {
    if (!_enabled) return;
    const a = _load(name);
    if (!a) return;
    try {
      // Reset si déjà en cours pour permettre les coups rapprochés
      a.currentTime = 0;
      a.volume = _volume;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  function setVolume(v) {
    _volume = Math.max(0, Math.min(1, v));
    for (const a of Object.values(_cache)) {
      if (a) a.volume = _volume;
    }
  }

  function setEnabled(v) { _enabled = !!v; }
  function isEnabled()    { return _enabled; }

  // Auto-prime au premier user gesture
  const onGesture = () => {
    prime();
    document.removeEventListener("click", onGesture);
    document.removeEventListener("keydown", onGesture);
  };
  document.addEventListener("click", onGesture, { once: true });
  document.addEventListener("keydown", onGesture, { once: true });

  return { prime, play, setVolume, setEnabled, isEnabled };
})();

window.Sounds = Sounds;