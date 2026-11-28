/* ==========================================================================
   LiLa Cashback — Leaderboard Achievement Share Card V2
   - Built-in ISO/IEC 18004 QR Code Encoder (Byte Mode, ECC-L, Versions 1..6)
   - Supports Story (9:16 = 1080x1920) & Square Post (1:1 = 1080x1080)
   - Zero external dependencies, zero CORS canvas taint, works 100% offline.
   ========================================================================== */
(function initLeaderboardShare(global) {
  // ---------------- Minimal Standards-Compliant QR Code (Versions 1..6, ECC-L) ----------------
  const QR_VERSIONS = [
    null,
    { size: 21, dataBytes: 19, ecBytes: 7, align: [] },
    { size: 25, dataBytes: 34, ecBytes: 10, align: [6, 18] },
    { size: 29, dataBytes: 55, ecBytes: 15, align: [6, 22] },
    { size: 33, dataBytes: 80, ecBytes: 20, align: [6, 26] },
    { size: 37, dataBytes: 108, ecBytes: 26, align: [6, 30] },
    { size: 41, dataBytes: 136, ecBytes: 18, blocks: 2, align: [6, 34] }
  ];

  // GF(256) with primitive polynomial 0x11d
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = GF_EXP[i];
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsComputeEc(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const rem = new Uint8Array(ecCount);
    for (let i = 0; i < data.length; i += 1) {
      const factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecCount - 1] = 0;
      if (factor !== 0) {
        for (let j = 0; j < ecCount; j += 1) {
          rem[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return rem;
  }

  function encodeQrMatrix(text) {
    const bytes = new TextEncoder().encode(String(text || 'https://lila.vn'));
    let ver = 1;
    for (; ver <= 6; ver += 1) {
      // 4 bits mode + 8 bits len + bytes*8 + 4 bits terminator <= dataBytes*8
      if (bytes.length + 2 <= QR_VERSIONS[ver].dataBytes) break;
    }
    if (ver > 6) ver = 6;
    const spec = QR_VERSIONS[ver];
    const maxPayload = Math.min(bytes.length, spec.dataBytes - 2);

    // Build bit stream: Byte mode (0100) + 8-bit length + payload + terminator + pad bytes
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    };
    pushBits(0b0100, 4);
    pushBits(maxPayload, 8);
    for (let i = 0; i < maxPayload; i += 1) pushBits(bytes[i], 8);
    pushBits(0, Math.min(4, spec.dataBytes * 8 - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    const data = new Uint8Array(spec.dataBytes);
    for (let i = 0; i < bits.length / 8; i += 1) {
      let b = 0;
      for (let k = 0; k < 8; k += 1) b = (b << 1) | bits[i * 8 + k];
      data[i] = b;
    }
    let padIdx = 0;
    for (let i = bits.length / 8; i < spec.dataBytes; i += 1) {
      data[i] = padIdx % 2 === 0 ? 0xec : 0x11;
      padIdx += 1;
    }

    // Compute EC blocks & interleave
    const numBlocks = spec.blocks || 1;
    const blockDataLen = Math.floor(spec.dataBytes / numBlocks);
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < numBlocks; b += 1) {
      const slice = data.subarray(b * blockDataLen, (b + 1) * blockDataLen);
      dataBlocks.push(slice);
      ecBlocks.push(rsComputeEc(slice, spec.ecBytes));
    }

    const codewords = [];
    for (let i = 0; i < blockDataLen; i += 1) {
      for (let b = 0; b < numBlocks; b += 1) codewords.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < spec.ecBytes; i += 1) {
      for (let b = 0; b < numBlocks; b += 1) codewords.push(ecBlocks[b][i]);
    }

    const n = spec.size;
    const mod = Array.from({ length: n }, () => new Int8Array(n)); // 0=empty, 1=black, -1=white
    const isFunc = Array.from({ length: n }, () => new Uint8Array(n));

    const setFunc = (r, c, dark) => {
      if (r < 0 || c < 0 || r >= n || c >= n) return;
      mod[r][c] = dark ? 1 : -1;
      isFunc[r][c] = 1;
    };

    const drawFinder = (top, left) => {
      for (let dr = -1; dr <= 7; dr += 1) {
        for (let dc = -1; dc <= 7; dc += 1) {
          const r = top + dr;
          const c = left + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const dark =
            inOuter &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFunc(r, c, dark);
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, n - 7);
    drawFinder(n - 7, 0);

    // Timing patterns
    for (let i = 8; i < n - 8; i += 1) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    if (spec.align.length >= 2) {
      const a = spec.align[1];
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunc(a + dr, a + dc, dark);
        }
      }
    }

    // Reserve format info cells + dark module
    for (let i = 0; i <= 8; i += 1) {
      if (!isFunc[8][i]) setFunc(8, i, false);
      if (!isFunc[i][8]) setFunc(i, 8, false);
    }
    for (let i = n - 8; i < n; i += 1) {
      if (!isFunc[8][i]) setFunc(8, i, false);
      if (!isFunc[i][8]) setFunc(i, 8, false);
    }
    setFunc(n - 8, 8, true);

    // Place data bits (zigzag) with Mask 0: (r + c) % 2 === 0
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert += 1) {
        const r = upward ? n - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const c = right - j;
          if (isFunc[r][c]) continue;
          let bit = 0;
          if (bitIdx < totalBits) {
            bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
            bitIdx += 1;
          }
          if ((r + c) % 2 === 0) bit ^= 1;
          mod[r][c] = bit ? 1 : -1;
        }
      }
      upward = !upward;
    }

    // Write Format Info for ECC-L (01) + Mask 0 (000) => 15-bit BCH formatted string = 0x77c4
    const fmt = 0x77c4;
    for (let i = 0; i <= 5; i += 1) setFunc(8, i, ((fmt >>> (14 - i)) & 1) === 1);
    setFunc(8, 7, ((fmt >>> 8) & 1) === 1);
    setFunc(8, 8, ((fmt >>> 7) & 1) === 1);
    setFunc(7, 8, ((fmt >>> 6) & 1) === 1);
    for (let i = 9; i < 15; i += 1) setFunc(14 - i, 8, ((fmt >>> (14 - i)) & 1) === 1);

    for (let i = 0; i < 8; i += 1) setFunc(8, n - 1 - i, ((fmt >>> i) & 1) === 1);
    for (let i = 8; i < 15; i += 1) setFunc(n - 15 + i, 8, ((fmt >>> i) & 1) === 1);

    return mod;
  }

  function drawQrCode(ctx, text, x, y, size) {
    const matrix = encodeQrMatrix(text);
    const n = matrix.length;
    const quiet = 2;
    const cell = size / (n + quiet * 2);

    ctx.save();
    drawRoundRect(ctx, x, y, size, size, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (matrix[r][c] === 1) {
          ctx.fillRect(
            Math.floor(x + (c + quiet) * cell),
            Math.floor(y + (r + quiet) * cell),
            Math.ceil(cell),
            Math.ceil(cell)
          );
        }
      }
    }
    ctx.restore();
  }

  // ---------------- Canvas Helpers ----------------
  function drawRoundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function loadImageSafe(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function formatVnd(amount) {
    const n = Math.max(0, Math.round(Number(amount || 0)));
    return `${n.toLocaleString('vi-VN')}đ`;
  }

  async function renderAchievementCard(canvas, payload) {
    if (!canvas || !payload) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isSquare = payload.ratio === 'square';
    const W = 1080;
    const H = isSquare ? 1080 : 1920;
    canvas.width = W;
    canvas.height = H;

    const isCashback = payload.mode === 'cashback';
    const hideAmount = Boolean(payload.hideAmount);
    const isAnon = Boolean(payload.isAnonymous);
    const titleLabel = isCashback ? 'VUA HOÀN TIỀN' : 'ĐẠI GIA LiLa';
    const metricLabel = isCashback ? 'TỔNG TIỀN HOÀN XÁC NHẬN' : 'TỔNG GIÁ TRỊ MUA SẮM HỢP LỆ';
    const metricVal = isCashback ? payload.totalCashback : payload.totalSpend;
    const seasonLabel = String(payload.seasonLabel || 'Toàn thời gian').toUpperCase();
    const displayName = isAnon
      ? 'Thành viên ẩn danh LiLa'
      : String(payload.displayName || 'Thành viên LiLa').trim();
    const rankNum = Number(payload.rank || 1);
    const tierName = String(payload.vipTierName || 'Thành viên LiLa').replace(/^Thành viên\s+/i, 'Hạng ');
    const refCode = String(payload.refCode || '').trim();
    const shareDeepLink =
      payload.shareUrl ||
      (refCode
        ? `${global.location?.origin || 'https://hoantiensan.online'}/?ref=${encodeURIComponent(refCode)}&src=lb_share&tab=${isCashback ? 'cashback' : 'spend'}`
        : `${global.location?.origin || 'https://hoantiensan.online'}/?src=lb_share`);

    // 1. Brand Gradient Background
    const grad = ctx.createLinearGradient(0, 0, W, H);
    if (isCashback) {
      grad.addColorStop(0, '#064e3b');
      grad.addColorStop(0.5, '#059669');
      grad.addColorStop(1, '#0d9488');
    } else {
      grad.addColorStop(0, '#991b1b');
      grad.addColorStop(0.5, '#ee4d2d');
      grad.addColorStop(1, '#f97316');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Subtle radial spotlight
    const spotY = isSquare ? 310 : 540;
    const spot = ctx.createRadialGradient(W / 2, spotY, 40, W / 2, spotY, 520);
    spot.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
    spot.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 2. Top Brand Pill & Title
    const brandY = isSquare ? 52 : 112;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    drawRoundRect(ctx, cx - 180, brandY, 360, 56, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.36)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 26px "Be Vietnam Pro", -apple-system, sans-serif';
    ctx.fillText('LiLa CASHBACK', cx, brandY + 29);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = '700 22px "Be Vietnam Pro", -apple-system, sans-serif';
    ctx.fillText(`BẢNG VINH DANH • ${seasonLabel}`, cx, brandY + (isSquare ? 88 : 112));

    ctx.fillStyle = '#fef08a';
    ctx.font = `800 ${isSquare ? 48 : 62}px "Be Vietnam Pro", -apple-system, sans-serif`;
    ctx.fillText(titleLabel, cx, brandY + (isSquare ? 142 : 186));

    // 3. Avatar Circle & Top #N Pill
    const cy = isSquare ? 330 : 510;
    const avatarR = isSquare ? 86 : 124;

    ctx.beginPath();
    ctx.arc(cx, cy, avatarR + 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(254, 240, 138, 0.28)';
    ctx.fill();

    const avatarImg = isAnon ? null : await loadImageSafe(payload.avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (avatarImg) {
      const scale = Math.max((avatarR * 2) / avatarImg.width, (avatarR * 2) / avatarImg.height);
      const dw = avatarImg.width * scale;
      const dh = avatarImg.height * scale;
      ctx.drawImage(avatarImg, cx - dw / 2, cy - dh / 2, dw, dh);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - avatarR, cy - avatarR, avatarR * 2, avatarR * 2);
      ctx.fillStyle = isCashback ? '#059669' : '#ee4d2d';
      ctx.font = `800 ${isSquare ? 68 : 96}px "Be Vietnam Pro", -apple-system, sans-serif`;
      ctx.fillText(isAnon ? '?' : (displayName.charAt(0).toUpperCase() || 'U'), cx, cy + 4);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
    ctx.strokeStyle = rankNum === 1 ? '#fde047' : '#ffffff';
    ctx.lineWidth = 7;
    ctx.stroke();

    const badgeW = isSquare ? 190 : 230;
    const badgeH = isSquare ? 50 : 62;
    drawRoundRect(ctx, cx - badgeW / 2, cy + avatarR - badgeH / 2, badgeW, badgeH, badgeH / 2);
    ctx.fillStyle = rankNum === 1 ? '#f59e0b' : '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${isSquare ? 26 : 32}px "Be Vietnam Pro", -apple-system, sans-serif`;
    ctx.fillText(`TOP #${rankNum}`, cx, cy + avatarR + 1);

    // 4. White Achievement Card
    const cardX = 72;
    const cardW = W - 144;
    const cardY = isSquare ? 464 : 696;
    const cardH = isSquare ? 310 : 540;
    drawRoundRect(ctx, cardX, cardY, cardW, cardH, 34);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.font = `800 ${isSquare ? 38 : 48}px "Be Vietnam Pro", -apple-system, sans-serif`;
    const clippedName = displayName.length > 22 ? `${displayName.slice(0, 21)}…` : displayName;
    ctx.fillText(clippedName, cx, cardY + (isSquare ? 58 : 92));

    const tierW = 280;
    const tierH = isSquare ? 40 : 48;
    drawRoundRect(ctx, cx - tierW / 2, cardY + (isSquare ? 90 : 138), tierW, tierH, tierH / 2);
    ctx.fillStyle = isCashback ? '#ecfdf5' : '#fff5f2';
    ctx.fill();
    ctx.fillStyle = isCashback ? '#047857' : '#c2410c';
    ctx.font = `700 ${isSquare ? 21 : 24}px "Be Vietnam Pro", -apple-system, sans-serif`;
    ctx.fillText(tierName, cx, cardY + (isSquare ? 111 : 163));

    const boxY = cardY + (isSquare ? 148 : 226);
    const boxH = isSquare ? 132 : 206;
    drawRoundRect(ctx, cardX + 44, boxY, cardW - 88, boxH, 24);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = `700 ${isSquare ? 19 : 23}px "Be Vietnam Pro", -apple-system, sans-serif`;
    ctx.fillText(hideAmount ? 'DANH HIỆU ĐANG NẮM GIỮ' : metricLabel, cx, boxY + (isSquare ? 38 : 56));

    ctx.fillStyle = isCashback ? '#059669' : '#ee4d2d';
    const bigLine = hideAmount ? `Top #${rankNum} ${titleLabel}` : formatVnd(metricVal);
    ctx.font = hideAmount
      ? `800 ${isSquare ? 34 : 44}px "Be Vietnam Pro", -apple-system, sans-serif`
      : `800 ${isSquare ? 52 : 68}px "Be Vietnam Pro", -apple-system, sans-serif`;
    ctx.fillText(bigLine, cx, boxY + (isSquare ? 88 : 132));

    if (!isSquare) {
      ctx.fillStyle = '#475569';
      ctx.font = '600 24px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText('Mua Shopee & TikTok Shop hoàn tiền tự động mỗi ngày', cx, cardY + 486);
    }

    // 5. Bottom QR Code + Referral CTA Panel
    const qrPanelY = isSquare ? 806 : 1304;
    const qrPanelH = isSquare ? 222 : 490;
    drawRoundRect(ctx, cardX, qrPanelY, cardW, qrPanelH, 30);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.24)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (isSquare) {
      // Side-by-side compact QR + CTA for 1:1 Post
      const qrSize = 176;
      const qrX = cardX + 26;
      const qrY = qrPanelY + 23;
      drawQrCode(ctx, shareDeepLink, qrX, qrY, qrSize);

      ctx.textAlign = 'left';
      const tx = qrX + qrSize + 28;
      ctx.fillStyle = '#fef08a';
      ctx.font = '800 25px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText('QUÉT MÃ NHẬN HOÀN TIỀN', tx, qrPanelY + 62);

      ctx.fillStyle = '#ffffff';
      ctx.font = '600 22px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText('Mua sắm hoàn tiền cùng mình trên LiLa,', tx, qrPanelY + 108);
      ctx.fillText(
        refCode ? `nhập mã ${refCode} để nhận ưu đãi!` : 'nhận hoàn tiền Shopee & TikTok ngay!',
        tx,
        qrPanelY + 142
      );

      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '700 20px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText(global.location?.host || 'LiLa Cashback', tx, qrPanelY + 186);
    } else {
      // Centered prominent QR + CTA for 9:16 Story
      const qrSize = 250;
      const qrX = cx - qrSize / 2;
      const qrY = qrPanelY + 34;
      drawQrCode(ctx, shareDeepLink, qrX, qrY, qrSize);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#fef08a';
      ctx.font = '800 28px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText('QUÉT QR THAM GIA CÙNG MÌNH', cx, qrY + qrSize + 44);

      ctx.fillStyle = '#ffffff';
      ctx.font = '600 25px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText('Mua sắm hoàn tiền cùng mình trên LiLa,', cx, qrY + qrSize + 92);
      ctx.fillText(
        refCode ? `nhập mã ${refCode} để nhận ưu đãi!` : 'nhận hoàn tiền Shopee & TikTok ngay!',
        cx,
        qrY + qrSize + 130
      );

      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '700 22px "Be Vietnam Pro", -apple-system, sans-serif';
      ctx.fillText(global.location?.host || 'LiLa Cashback', cx, qrPanelY + qrPanelH - 26);
    }
  }

  global.LiLaLeaderboardShare = {
    renderAchievementCard,
    encodeQrMatrix
  };
})(window);
