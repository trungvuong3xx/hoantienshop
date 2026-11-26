/* LiLa Shiba Companion (Mẫu B: Shiba Mochi) — Modular Interactive Mascot */
(function initShibaCompanionModule() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return;

  const STORAGE_KEY = 'lila_shiba_companion_mode_v1'; // 'active' | 'sleep' | 'hidden'
  const REDUCED_MOTION = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IS_MOBILE = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;

  const TAP_PHRASES = [
    'Gâu! Chúc Sen mua sắm vui vẻ nha!',
    'Sen nhớ mua qua LiLa để nhận Cashback nhé!',
    'Sen ơi, nhớ kiểm tra đơn hàng của mình nha!',
    'Chúc Sen săn được món đồ yêu thích!',
    'Gâu gâu! Hôm nay Sen có đơn mới chưa nè?',
    'Sen nhớ xóa hàng cũ trong giỏ trước khi bấm link nha!',
    'Boss Shiba ở đây canh tiền hoàn cho Sen nè!',
    'Sen chạm thêm cái nữa là Boss vui cả ngày luôn!'
  ];

  const AMBIENT_PHRASES = [
    'Gâu! Sen đang săn món gì thế?',
    'Dán link Shopee vào LiLa là có hoàn tiền liền nha Sen!',
    'Boss Shiba vẫy đuôi cổ vũ Sen chốt đơn!',
    'Sen nhớ ghé tab Đơn hàng xem tiền hoàn nha!',
    'Hôm nay Sen có săn sale không nè?'
  ];

  const PEEK_PHRASES = [
    'Sen ơi... đang xem món gì thế? 👀',
    'Gâu! Boss đang lén canh deal cho Sen nè 👀',
    'Lấp ló chút xíu... Sen chốt đơn chưa? 👀',
    'Suỵt! Boss núp ở đây đợi tiền hoàn về cho Sen!'
  ];
  // 1. ShibaSettings — persists user preference safely
  const ShibaSettings = {
    getMode() {
      try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'hidden' || v === 'sleep' || v === 'active') return v;
      } catch {}
      return 'active';
    },
    setMode(mode) {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {}
      window.dispatchEvent(new CustomEvent('lila:shiba-mode-changed', { detail: { mode } }));
    }
  };

  // 2. ShibaCharacter — Mẫu B Shiba Mochi SVG (brand-matched LiLa colors)
  function createShibaCharacterEl() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'lilaShibaActor';
    btn.className = 'shiba-actor';
    btn.setAttribute('data-state', 'idle');
    btn.setAttribute('aria-label', 'Bé Shiba LiLa — Chạm để tương tác');
    btn.innerHTML = `
      <span class="shiba-zzz" aria-hidden="true">Zzz</span>
      <div class="shiba-sprite-flip">
        <svg class="shiba-svg" viewBox="0 0 110 110" aria-hidden="true">
          <ellipse cx="55" cy="98" rx="31" ry="6" fill="#0f172a" opacity="0.12"/>
          <circle class="shiba-tail" cx="19" cy="68" r="10" fill="#F6A14E" stroke="#854D0E" stroke-width="2.6"/>
          <ellipse class="shiba-paw-l" cx="38" cy="91" rx="7.5" ry="7" fill="#F6A14E" stroke="#854D0E" stroke-width="2.5"/>
          <ellipse class="shiba-paw-r" cx="72" cy="91" rx="7.5" ry="7" fill="#F6A14E" stroke="#854D0E" stroke-width="2.5"/>
          <g class="shiba-ear-l">
            <path d="M32 39 C26 20, 38 14, 48 28 Z" fill="#F6A14E" stroke="#854D0E" stroke-width="2.6" stroke-linejoin="round"/>
            <path d="M34 34 C31 24, 38 20, 44 29 Z" fill="#FFE4C4"/>
          </g>
          <g class="shiba-ear-r">
            <path d="M78 39 C84 20, 72 14, 62 28 Z" fill="#F6A14E" stroke="#854D0E" stroke-width="2.6" stroke-linejoin="round"/>
            <path d="M76 34 C79 24, 72 20, 66 29 Z" fill="#FFE4C4"/>
          </g>
          <path d="M18 68 C18 35, 34 24, 55 24 C76 24, 92 35, 92 68 C92 88, 78 93, 55 93 C32 93, 18 88, 18 68 Z" fill="#F6A14E" stroke="#854D0E" stroke-width="2.8"/>
          <g class="shiba-belly">
            <path d="M25 68 C25 50, 39 45, 55 47 C71 45, 85 50, 85 68 C85 85, 73 90, 55 90 C37 90, 25 85, 25 68 Z" fill="#FFF7EB"/>
          </g>
          <ellipse cx="45" cy="41" rx="3.3" ry="2.2" fill="#FFF7EB"/>
          <ellipse cx="69" cy="41" rx="3.3" ry="2.2" fill="#FFF7EB"/>
          <g class="shiba-eyes-normal">
            <circle cx="45" cy="51" r="4.5" fill="#1E293B"/>
            <circle cx="46.5" cy="49.5" r="1.6" fill="#fff"/>
            <circle cx="70" cy="51" r="4.5" fill="#1E293B"/>
            <circle cx="71.5" cy="49.5" r="1.6" fill="#fff"/>
          </g>
          <g class="shiba-eyes-happy">
            <path d="M40 52 Q45 46 50 52" fill="none" stroke="#1E293B" stroke-width="2.8" stroke-linecap="round"/>
            <path d="M65 52 Q70 46 75 52" fill="none" stroke="#1E293B" stroke-width="2.8" stroke-linecap="round"/>
          </g>
          <g class="shiba-eyes-sleep">
            <path d="M40 52 Q45 56 50 52" fill="none" stroke="#1E293B" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M65 52 Q70 56 75 52" fill="none" stroke="#1E293B" stroke-width="2.5" stroke-linecap="round"/>
          </g>
          <g class="shiba-eyes-surprised">
            <circle cx="45" cy="51" r="5.4" fill="#fff" stroke="#1E293B" stroke-width="2.2"/>
            <circle cx="45" cy="51" r="2.2" fill="#1E293B"/>
            <circle cx="70" cy="51" r="5.4" fill="#fff" stroke="#1E293B" stroke-width="2.2"/>
            <circle cx="70" cy="51" r="2.2" fill="#1E293B"/>
          </g>
          <g class="shiba-eyes-sad">
            <path d="M40 53 L49 49" fill="none" stroke="#1E293B" stroke-width="2.6" stroke-linecap="round"/>
            <path d="M75 53 L66 49" fill="none" stroke="#1E293B" stroke-width="2.6" stroke-linecap="round"/>
          </g>
          <ellipse cx="35" cy="58" rx="5.2" ry="3" fill="#FDA4AF" opacity="0.82"/>
          <ellipse cx="80" cy="58" rx="5.2" ry="3" fill="#FDA4AF" opacity="0.82"/>
          <ellipse cx="58" cy="55" rx="3.3" ry="2.3" fill="#1E293B"/>
          <path d="M51 60 Q54.5 64 58 60 Q61.5 64 65 60" fill="none" stroke="#1E293B" stroke-width="2.2" stroke-linecap="round"/>
          <polygon points="58,74 49,69 49,79" fill="#EE4D2D"/>
          <polygon points="58,74 67,69 67,79" fill="#EE4D2D"/>
          <circle cx="58" cy="74" r="3" fill="#FBBF24"/>
        </svg>
      </div>`;
    return btn;
  }

  // Mount DOM container
  const layer = document.createElement('div');
  layer.id = 'lilaShibaLayer';
  layer.className = 'shiba-companion-layer';
  layer.setAttribute('aria-live', 'polite');

  const actor = createShibaCharacterEl();
  layer.appendChild(actor);

  const bubble = document.createElement('div');
  bubble.id = 'lilaShibaBubble';
  bubble.className = 'shiba-bubble';
  bubble.setAttribute('role', 'status');
  bubble.innerHTML = `
    <div id="lilaShibaBubbleText"></div>
    <div class="shiba-bubble-actions">
      <button type="button" class="shiba-mini-btn" id="shibaSleepToggleBtn">💤 Cho bé ngủ</button>
      <button type="button" class="shiba-mini-btn" id="shibaHideBtn">Ẩn bé</button>
    </div>`;

  document.body.appendChild(layer);
  document.body.appendChild(bubble);

  const bubbleTextEl = document.getElementById('lilaShibaBubbleText');
  const sleepToggleBtn = document.getElementById('shibaSleepToggleBtn');
  const hideBtn = document.getElementById('shibaHideBtn');

  // 3. ShibaSpeechBubble — clamped inside viewport, auto-hides, avoids immediate repeat
  let bubbleTimer = null;
  let lastPhraseIdx = -1;
  let lastAmbientIdx = -1;
  let lastAmbientAt = 0;

  const ShibaSpeechBubble = {
    isVisible() {
      return bubble.classList.contains('is-visible');
    },
    show(text, { durationMs = 3600, showActions = true } = {}) {
      if (!bubbleTextEl || ShibaVisibilityController.isSuppressed()) return;
      bubbleTextEl.textContent = text;
      const actionsEl = bubble.querySelector('.shiba-bubble-actions');
      if (actionsEl) actionsEl.style.display = showActions ? 'flex' : 'none';
      if (sleepToggleBtn) {
        sleepToggleBtn.textContent = ShibaSettings.getMode() === 'sleep' ? '☀️ Gọi dậy' : '💤 Cho bé ngủ';
      }
      const vw = window.innerWidth || 390;
      const bw = Math.min(268, vw - 24);
      const desiredLeft = Math.round(ShibaAnimationController.x + 28 - bw / 2);
      const clampedLeft = Math.max(12, Math.min(desiredLeft, vw - bw - 12));
      bubble.style.left = `${clampedLeft}px`;
      bubble.classList.add('is-visible');
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => ShibaSpeechBubble.hide(), durationMs);
    },
    hide() {
      clearTimeout(bubbleTimer);
      bubble.classList.remove('is-visible');
    },
    pickRandomPhrase() {
      let idx = Math.floor(Math.random() * TAP_PHRASES.length);
      if (idx === lastPhraseIdx) idx = (idx + 1) % TAP_PHRASES.length;
      lastPhraseIdx = idx;
      return TAP_PHRASES[idx];
    },
    pickAmbientPhrase() {
      let idx = Math.floor(Math.random() * AMBIENT_PHRASES.length);
      if (idx === lastAmbientIdx) idx = (idx + 1) % AMBIENT_PHRASES.length;
      lastAmbientIdx = idx;
      return AMBIENT_PHRASES[idx];
    }
  };

  const MAX_ACTIVE_PARTICLES = 12;
  let activeParticleCount = 0;
  let lastParticleBurstAt = 0;

  function spawnParticles(symbols = ['🧡', '🪙', '✨', '❤️'], { force = false } = {}) {
    if (REDUCED_MOTION() || ShibaVisibilityController.isSuppressed()) return;
    const now = Date.now();
    if (!force && now - lastParticleBurstAt < 420) return;
    lastParticleBurstAt = now;
    const rect = actor.getBoundingClientRect();
    const centerX = rect.left + rect.width * 0.5;
    const topY = rect.top + 4;
    const count = symbols.length;
    symbols.forEach((sym, idx) => {
      const delayMs = idx * 75;
      setTimeout(() => {
        if (ShibaVisibilityController.isSuppressed()) return;
        if (activeParticleCount >= MAX_ACTIVE_PARTICLES) return;
        activeParticleCount += 1;
        const p = document.createElement('span');
        p.className = 'shiba-particle';
        p.textContent = sym;
        const spread = count > 1 ? (idx / (count - 1) - 0.5) * 64 : 0;
        const jitterX = (Math.random() - 0.5) * 18;
        const dx = Math.round(spread + jitterX);
        const dy = -Math.round(52 + Math.random() * 34);
        const rot = Math.round((Math.random() - 0.5) * 34);
        p.style.left = `${Math.round(centerX - 8 + (Math.random() - 0.5) * 16)}px`;
        p.style.top = `${Math.round(topY)}px`;
        p.style.setProperty('--dx', `${dx}px`);
        p.style.setProperty('--dy', `${dy}px`);
        p.style.setProperty('--rot', `${rot}deg`);
        document.body.appendChild(p);
        setTimeout(() => {
          p.remove();
          activeParticleCount = Math.max(0, activeParticleCount - 1);
        }, 1180);
      }, delayMs);
    });
  }

  function spawnPawprint() {
    if (REDUCED_MOTION() || ShibaVisibilityController.isSuppressed()) return;
    if (activeParticleCount >= MAX_ACTIVE_PARTICLES) return;
    const rect = actor.getBoundingClientRect();
    activeParticleCount += 1;
    const paw = document.createElement('span');
    paw.className = 'shiba-pawprint';
    paw.textContent = '🐾';
    paw.style.left = `${Math.round(rect.left + rect.width * 0.42)}px`;
    paw.style.top = `${Math.round(rect.bottom - 12)}px`;
    document.body.appendChild(paw);
    setTimeout(() => {
      paw.remove();
      activeParticleCount = Math.max(0, activeParticleCount - 1);
    }, 860);
  }

  function spawnStopDust(movingLeft = false) {
    if (REDUCED_MOTION() || ShibaVisibilityController.isSuppressed()) return;
    const rect = actor.getBoundingClientRect();
    for (let i = 0; i < 2; i += 1) {
      if (activeParticleCount >= MAX_ACTIVE_PARTICLES) break;
      activeParticleCount += 1;
      const d = document.createElement('span');
      d.className = 'shiba-dust';
      d.style.left = `${Math.round(rect.left + (movingLeft ? rect.width * 0.72 : rect.width * 0.22) + i * 6)}px`;
      d.style.top = `${Math.round(rect.bottom - 10)}px`;
      d.style.setProperty('--dx', `${movingLeft ? 10 + i * 5 : -(10 + i * 5)}px`);
      document.body.appendChild(d);
      setTimeout(() => {
        d.remove();
        activeParticleCount = Math.max(0, activeParticleCount - 1);
      }, 540);
    }
  }

  // 4. ShibaVisibilityController — pauses on hidden tab, admin, modal, keyboard, user hide
  const ShibaVisibilityController = {
    isSuppressed() {
      if (ShibaSettings.getMode() === 'hidden') return true;
      if (document.hidden) return true;
      if (document.documentElement.classList.contains('kb-open')) return true;
      if (document.getElementById('view-admin')?.classList.contains('active')) return true;
      if (document.querySelector('.modal-backdrop:not(.hidden), dialog.app-choice-dialog[open], .notif-dropdown:not(.hidden), .order-detail-overlay.is-open, .referral-sheet-overlay.is-open, .withdraw-sheet-overlay.is-open')) {
        return true;
      }
      return false;
    },
    sync() {
      const mode = ShibaSettings.getMode();
      layer.classList.toggle('is-hidden-by-user', mode === 'hidden');
      const paused = document.hidden || this.isSuppressed();
      layer.classList.toggle('is-paused', paused);
      if (paused) {
        ShibaSpeechBubble.hide();
        ShibaAnimationController.stopTimer();
      } else {
        ShibaAnimationController.resumeIfNeeded();
      }
    }
  };

  // 5. ShibaAnimationController — gentle state machine using setTimeout + CSS transition (zero setInterval)
  const ShibaAnimationController = {
    x: 18,
    state: 'idle',
    timer: null,
    getBounds() {
      const vw = window.innerWidth || 390;
      const actorWidth = IS_MOBILE() ? 56 : 66;
      const minX = IS_MOBILE() ? 10 : 14;
      let rightReserve = 12;
      let zaloVisible = false;
      const zaloEl = document.querySelector('.floating-zalo:not(.hidden)');
      if (zaloEl && typeof window.getComputedStyle === 'function' && window.getComputedStyle(zaloEl).display !== 'none') {
        const zRect = zaloEl.getBoundingClientRect();
        if (zRect.width > 0 && zRect.height > 0) {
          zaloVisible = true;
          rightReserve = Math.max(12, Math.ceil(vw - zRect.left) + 10);
        }
      }
      const maxX = Math.max(minX + 24, vw - actorWidth - rightReserve);
      return { minX, maxX, vw, actorWidth, zaloVisible };
    },
    setPosition(nextX, durationMs = 0, { allowEdgePeek = false, easing = 'cubic-bezier(0.25, 0.85, 0.35, 1)' } = {}) {
      const { minX, maxX, vw, actorWidth } = this.getBounds();
      const peekInset = IS_MOBILE() ? 22 : 26;
      const lowerBound = allowEdgePeek ? -peekInset : minX;
      const upperBound = allowEdgePeek ? vw - actorWidth + peekInset : maxX;
      const clamped = Math.max(lowerBound, Math.min(nextX, upperBound));
      if (durationMs > 0 && Math.abs(clamped - this.x) > 4) {
        actor.classList.toggle('facing-left', clamped < this.x);
      }
      actor.style.transitionTimingFunction = easing;
      actor.style.transitionDuration = `${durationMs}ms`;
      this.x = clamped;
      actor.style.transform = `translate3d(${Math.round(this.x)}px, 0, 0)`;
    },
    brakeTo(nextState, nextDelayMs, onSettled) {
      // Smooth Walk -> decelerate brake + dust puff -> Idle/Sit/Happy
      this.stopTimer();
      actor.classList.add('is-braking');
      spawnStopDust(actor.classList.contains('facing-left'));
      this.timer = setTimeout(() => {
        actor.classList.remove('is-braking');
        if (ShibaVisibilityController.isSuppressed() || ShibaSettings.getMode() !== 'active') return;
        this.setState(nextState);
        if (typeof onSettled === 'function') onSettled();
        this.scheduleNext(nextDelayMs);
      }, 260);
    },
    startPeek(preferredSide = null) {
      const { vw, actorWidth, zaloVisible } = this.getBounds();
      const peekInset = IS_MOBILE() ? 20 : 24;
      const canPeekRight = !zaloVisible;
      const side = preferredSide || (canPeekRight && (this.x > vw * 0.5 || Math.random() < 0.45) ? 'right' : 'left');
      const peekX = side === 'right' ? vw - actorWidth + peekInset : -peekInset;
      const faceLeftWhenPeeking = side === 'right';
      const dist = Math.abs(this.x - peekX);
      const slideMs = Math.max(450, Math.min(2200, Math.round(dist * 12)));
      const enterPeek = () => {
        if (ShibaVisibilityController.isSuppressed() || ShibaSettings.getMode() !== 'active') return;
        actor.classList.toggle('facing-left', faceLeftWhenPeeking);
        this.setState('peek');
        if (!ShibaSpeechBubble.isVisible() && Math.random() < 0.72) {
          const msg = PEEK_PHRASES[Math.floor(Math.random() * PEEK_PHRASES.length)];
          ShibaSpeechBubble.show(msg, { durationMs: 3200, showActions: false });
        }
        spawnParticles(['👀', '✨']);
        this.scheduleNext(3400 + Math.random() * 1800);
      };
      if (dist > 10) {
        this.setState('walk');
        this.setPosition(peekX, slideMs, { allowEdgePeek: true });
        this.stopTimer();
        this.timer = setTimeout(enterPeek, slideMs + 80);
      } else {
        this.setPosition(peekX, 320, { allowEdgePeek: true });
        enterPeek();
      }
    },
    setState(nextState) {
      actor.classList.remove('is-braking');
      this.state = nextState;
      actor.setAttribute('data-state', nextState);
    },
    stopTimer() {
      clearTimeout(this.timer);
      this.timer = null;
    },
    scheduleNext(delayMs) {
      this.stopTimer();
      if (ShibaVisibilityController.isSuppressed()) return;
      if (ShibaSettings.getMode() === 'sleep') {
        this.setState('sleep');
        return;
      }
      this.timer = setTimeout(() => this.stepCycle(), delayMs);
    },
    maybeSpeakAmbient() {
      const now = Date.now();
      if (ShibaSpeechBubble.isVisible() || now - lastAmbientAt < 13000) return;
      if (Math.random() < 0.52) {
        lastAmbientAt = now;
        ShibaSpeechBubble.show(ShibaSpeechBubble.pickAmbientPhrase(), { durationMs: 3200, showActions: false });
        spawnParticles(['🧡', '✨']);
      }
    },
    stepCycle() {
      if (ShibaVisibilityController.isSuppressed() || ShibaSettings.getMode() !== 'active') return;
      if (REDUCED_MOTION()) {
        this.setState('idle');
        return;
      }

      const roll = Math.random();
      if (this.state === 'peek') {
        // Step back out smoothly from whichever side edge Shiba is peeking from
        const { minX, maxX, vw } = this.getBounds();
        const isRightEdge = this.x > vw * 0.5;
        const exitTarget = isRightEdge
          ? Math.max(minX, maxX - 20 - Math.random() * 60)
          : Math.min(maxX, minX + 20 + Math.random() * 60);
        this.setState('walk');
        this.setPosition(exitTarget, 850);
        this.scheduleNext(870);
        return;
      }

      if (this.state === 'walk') {
        // Natural transition: Walk -> brake + dust -> Idle / Sit / Happy
        if (roll < 0.34) {
          this.brakeTo('happy', 1400 + Math.random() * 800, () => {
            spawnParticles(['🧡', '🪙', '✨']);
            this.maybeSpeakAmbient();
          });
        } else if (roll < 0.68) {
          this.brakeTo('sit', 2200 + Math.random() * 1600, () => this.maybeSpeakAmbient());
        } else {
          this.brakeTo('idle', 1900 + Math.random() * 1500);
        }
        return;
      }

      if (roll < 0.2) {
        // Hide at the side edge and peek curiously!
        this.startPeek();
        return;
      }

      if (roll < 0.66) {
        // Take a lively stroll across the full bottom width with subtle pawprints
        const { minX, maxX } = this.getBounds();
        const span = maxX - minX;
        if (span > 24) {
          const maxStep = Math.min(420, Math.max(120, span * 0.68));
          const minStep = Math.min(110, span * 0.25);
          const stepDist = minStep + Math.random() * Math.max(20, maxStep - minStep);
          const dir = this.x <= minX + 40 ? 1 : this.x >= maxX - 40 ? -1 : (Math.random() < 0.5 ? 1 : -1);
          const target = Math.max(minX, Math.min(maxX, this.x + stepDist * dir));
          const dist = Math.abs(target - this.x);
          const walkMs = Math.max(1150, Math.min(3000, Math.round(dist * 13)));
          this.setState('walk');
          this.setPosition(target, walkMs);
          setTimeout(() => { if (this.state === 'walk') spawnPawprint(); }, Math.round(walkMs * 0.35));
          setTimeout(() => { if (this.state === 'walk') spawnPawprint(); }, Math.round(walkMs * 0.7));
          this.scheduleNext(walkMs + 60);
          return;
        }
      }

      if (roll < 0.79) {
        // Curious head-tilt observation
        this.setState('curious');
        this.maybeSpeakAmbient();
        this.scheduleNext(1900 + Math.random() * 1300);
        return;
      }

      if (roll < 0.91) {
        // Spontaneous happy hop with hearts & coins
        this.setState('happy');
        spawnParticles(['🧡', '🪙', '❤️', '✨']);
        this.maybeSpeakAmbient();
        this.scheduleNext(1500 + Math.random() * 1000);
        return;
      }

      // Natural Idle -> Sit calm breather
      const nextCalm = this.state === 'idle' ? 'sit' : 'idle';
      this.setState(nextCalm);
      this.scheduleNext(2200 + Math.random() * 1600);
    },
    react({ state = 'happy', message = '', particles = ['🧡', '🪙', '❤️', '✨'], durationMs = 3600, showActions = false, forceParticles = false }) {
      if (ShibaSettings.getMode() === 'hidden') return;
      if (ShibaVisibilityController.isSuppressed()) return;
      this.stopTimer();
      this.setState(state);
      if (particles && particles.length) spawnParticles(particles, { force: forceParticles });
      if (message) ShibaSpeechBubble.show(message, { durationMs, showActions });
      this.timer = setTimeout(() => {
        if (ShibaSettings.getMode() === 'sleep') {
          this.setState('sleep');
        } else {
          this.setState('idle');
          this.scheduleNext(2100 + Math.random() * 1600);
        }
      }, 1450);
    },
    resumeIfNeeded() {
      if (ShibaSettings.getMode() === 'sleep') {
        this.setState('sleep');
        return;
      }
      if (!this.timer && ShibaSettings.getMode() === 'active') {
        this.setState('idle');
        this.scheduleNext(1300 + Math.random() * 1100);
      }
    }
  };

  // User interactions: progressive taps (1st curious -> 2nd happy -> 3rd+ excited rate-limited) + gentle pet swipe
  let tapComboCount = 0;
  let lastTapAt = 0;
  let petStartX = null;
  let petTriggered = false;

  actor.addEventListener('pointerdown', (e) => {
    petStartX = e.clientX;
    petTriggered = false;
  }, { passive: true });

  actor.addEventListener('pointermove', (e) => {
    if (petStartX === null || petTriggered) return;
    if (Math.abs(e.clientX - petStartX) >= 18) {
      petTriggered = true;
      petStartX = null;
      if (ShibaSettings.getMode() === 'sleep') ShibaSettings.setMode('active');
      ShibaAnimationController.react({
        state: 'happy',
        message: 'Gừ... Sen vuốt đầu đã quá nha~ 🧡',
        particles: ['🧡', '❤️', '✨', '🧡'],
        showActions: true
      });
    }
  }, { passive: true });

  actor.addEventListener('pointerup', () => { petStartX = null; }, { passive: true });
  actor.addEventListener('pointercancel', () => { petStartX = null; }, { passive: true });

  actor.addEventListener('click', (e) => {
    e.stopPropagation();
    if (petTriggered) {
      petTriggered = false;
      return;
    }
    if (ShibaSettings.getMode() === 'sleep') {
      ShibaSettings.setMode('active');
      tapComboCount = 0;
      ShibaAnimationController.react({
        state: 'surprised',
        message: 'Gâu! Bé thức dậy cùng Sen săn deal rồi nè!',
        particles: ['🧡', '✨', '❤️'],
        showActions: true,
        forceParticles: true
      });
      return;
    }
    if (ShibaAnimationController.state === 'peek') {
      const { minX, maxX, vw } = ShibaAnimationController.getBounds();
      const stepInX = ShibaAnimationController.x > vw * 0.5 ? Math.max(minX, maxX - 24) : minX + 18;
      ShibaAnimationController.setPosition(stepInX, 420);
      tapComboCount = 1;
      lastTapAt = Date.now();
      ShibaAnimationController.react({
        state: 'happy',
        message: 'Á! Bị Sen phát hiện đang núp ngó nghiêng rồi!',
        particles: ['🧡', '✨', '❤️', '🪙', '✨'],
        showActions: true,
        forceParticles: true
      });
      return;
    }

    const now = Date.now();
    tapComboCount = now - lastTapAt < 4500 ? tapComboCount + 1 : 1;
    lastTapAt = now;

    if (tapComboCount === 1) {
      // 1st tap: look curiously at Sen & wag tail
      ShibaAnimationController.react({
        state: 'curious',
        message: 'Gâu! Sen gọi Boss hả? 🧡',
        particles: ['🧡', '✨'],
        showActions: true,
        forceParticles: true
      });
    } else if (tapComboCount === 2) {
      // 2nd tap: joyful jump + coins & hearts
      ShibaAnimationController.react({
        state: 'happy',
        message: ShibaSpeechBubble.pickRandomPhrase(),
        particles: ['🧡', '🪙', '❤️', '✨', '🪙'],
        showActions: true,
        forceParticles: true
      });
    } else {
      // 3rd+ consecutive tap: excited expression, particle rate-limited automatically
      ShibaAnimationController.react({
        state: 'happy',
        message: 'Gâu gâu! Boss thích được Sen nựng quá trời luôn! 🥰',
        particles: ['❤️', '🧡', '✨'],
        showActions: true,
        forceParticles: false
      });
    }
  });

  sleepToggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = ShibaSettings.getMode();
    if (cur === 'sleep') {
      ShibaSettings.setMode('active');
      ShibaAnimationController.react({
        state: 'happy',
        message: 'Gâu! Dậy săn Cashback cùng Sen thôi!',
        particles: ['🧡', '🪙', '✨', '❤️'],
        showActions: false
      });
    } else {
      ShibaSettings.setMode('sleep');
      ShibaAnimationController.stopTimer();
      ShibaAnimationController.setState('sleep');
      ShibaSpeechBubble.show('Khò khò... Sen chạm vào bé để gọi dậy nhé!', { durationMs: 2600, showActions: false });
    }
  });

  hideBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ShibaSettings.setMode('hidden');
    ShibaSpeechBubble.hide();
    ShibaVisibilityController.sync();
  });

  document.addEventListener('click', (e) => {
    if (!bubble.classList.contains('is-visible')) return;
    if (e.target.closest?.('#lilaShibaBubble') || e.target.closest?.('#lilaShibaActor')) return;
    ShibaSpeechBubble.hide();
  });

  // 6. ShibaEventListener — connects to REAL verified LiLa Cashback events (distinct states)
  window.addEventListener('lila:convert-success', () => {
    if (ShibaSettings.getMode() === 'hidden') return;
    ShibaAnimationController.react({
      state: 'happy',
      message: 'Tuyệt vời! Link đã sẵn sàng, Sen mua qua link này để nhận hoàn tiền nhé!',
      particles: ['🪙', '✨', '🧡', '🪙', '💛', '✨'],
      durationMs: 4400,
      showActions: false,
      forceParticles: true
    });
  });

  window.addEventListener('lila:convert-error', () => {
    if (ShibaSettings.getMode() === 'hidden') return;
    ShibaAnimationController.react({
      state: 'sad',
      message: 'Ôi, link này chưa hợp lệ rồi. Sen thử dán lại link sản phẩm nhé!',
      particles: [],
      durationMs: 3600,
      showActions: false
    });
  });

  window.addEventListener('lila:order-update', () => {
    if (ShibaSettings.getMode() === 'hidden') return;
    ShibaAnimationController.react({
      state: 'curious',
      message: 'Gâu! LiLa vừa ghi nhận đơn hàng mới của Sen rồi nè!',
      particles: ['🧡', '✨'],
      durationMs: 4000,
      showActions: false,
      forceParticles: true
    });
  });

  window.addEventListener('lila:cashback-confirmed', () => {
    if (ShibaSettings.getMode() === 'hidden') return;
    ShibaAnimationController.react({
      state: 'happy',
      message: 'Chúc mừng Sen! Đơn hàng đã được xác nhận Cashback rồi! 🪙',
      particles: ['🪙', '✨', '🧡', '🪙', '💛', '🪙', '❤️'],
      durationMs: 4600,
      showActions: false,
      forceParticles: true
    });
  });

  // Lifecycle & resize observers
  document.addEventListener('visibilitychange', () => ShibaVisibilityController.sync());
  window.addEventListener('resize', () => {
    ShibaAnimationController.setPosition(ShibaAnimationController.x, 0);
  }, { passive: true });

  // Public API for Account settings toggle & quick preview
  window.LilaShiba = {
    getMode: () => ShibaSettings.getMode(),
    setState(state) {
      if (state === 'peek') {
        ShibaAnimationController.stopTimer();
        actor.classList.remove('facing-left');
        ShibaAnimationController.setPosition(IS_MOBILE() ? -20 : -24, 380, { allowEdgePeek: true });
        ShibaAnimationController.setState('peek');
        spawnParticles(['👀', '✨']);
        return;
      }
      if (ShibaAnimationController.state === 'peek') {
        const { minX } = ShibaAnimationController.getBounds();
        ShibaAnimationController.setPosition(minX + 12, 320);
      }
      ShibaAnimationController.stopTimer();
      ShibaAnimationController.setState(state);
      if (state === 'happy') spawnParticles(['🧡', '🪙', '❤️', '✨']);
    },
    show() {
      ShibaSettings.setMode('active');
      ShibaVisibilityController.sync();
      ShibaAnimationController.react({
        state: 'happy',
        message: 'Gâu! Bé Shiba quay lại đồng hành cùng Sen rồi!',
        particles: ['🧡', '🪙', '❤️', '✨'],
        showActions: false
      });
    },
    sleep() {
      ShibaSettings.setMode('sleep');
      ShibaAnimationController.stopTimer();
      ShibaAnimationController.setState('sleep');
      ShibaVisibilityController.sync();
    },
    hide() {
      ShibaSettings.setMode('hidden');
      ShibaSpeechBubble.hide();
      ShibaVisibilityController.sync();
    }
  };

  // Boot cleanly
  ShibaAnimationController.setPosition(18, 0);
  ShibaVisibilityController.sync();
})();
