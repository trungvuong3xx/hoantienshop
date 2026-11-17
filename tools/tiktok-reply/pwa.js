(() => {
  const status = document.getElementById('pwaStatus');
  const panel = document.getElementById('installPanel');
  const button = document.getElementById('installButton');
  const guide = document.getElementById('installGuide');
  let installPrompt = null;
  let offlineReady = false;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function update() {
    status.textContent = offlineReady
      ? (navigator.onLine === false ? 'Đang dùng ngoại tuyến' : 'Sẵn sàng dùng ngoại tuyến')
      : 'Công cụ độc lập';
    panel.hidden = standalone();
  }
  button.addEventListener('click', async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try { await prompt.prompt(); await prompt.userChoice; } catch { showGuide(); }
      return;
    }
    showGuide();
  });
  function showGuide() {
    document.getElementById('installInstructions').textContent = location.protocol === 'file:'
      ? 'Để cài trên điện thoại, hãy mở đường link HTTPS của công cụ. File trên máy tính vẫn dùng được trực tiếp.'
      : ios
        ? 'Mở trang bằng Safari → nhấn Chia sẻ → Thêm vào Màn hình chính → bật Mở dưới dạng ứng dụng web nếu có → Thêm.'
        : 'Mở trang bằng Chrome → nhấn menu ⋮ → Cài đặt ứng dụng hoặc Thêm vào màn hình chính. Trên máy tính, dùng biểu tượng cài đặt trên thanh địa chỉ nếu có.';
    guide.showModal();
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    update();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; panel.hidden = true; });
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => { offlineReady = true; update(); })
      .catch(() => { status.textContent = 'Chưa lưu được ngoại tuyến — thử tải lại khi có mạng'; });
  }
})();
