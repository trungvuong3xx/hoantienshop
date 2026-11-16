function showConnectionReason() {
  const reason = navigator.onLine === false ? 'offline' : document.body.dataset.reason;
  const messages = {
    offline: ['Thiết bị đang mất mạng', 'Hãy bật Wi-Fi hoặc dữ liệu di động (4G/5G), tắt chế độ máy bay rồi nhấn Thử kết nối lại.'],
    timeout: ['Kết nối quá lâu', 'Ứng dụng chưa tải xong sau 10 giây. Mạng có thể yếu hoặc máy chủ phản hồi chậm. Hãy thử đổi Wi-Fi sang 4G/5G rồi kết nối lại.'],
    server: ['Máy chủ tạm thời gặp lỗi', 'Ứng dụng chưa thể tải dữ liệu từ máy chủ. Vui lòng thử lại sau vài phút.'],
    connection: ['Không thể kết nối đến LiLa', 'Chưa xác định được lỗi từ mạng hay máy chủ. Hãy thử mở một trang web khác, đổi Wi-Fi/4G/5G rồi nhấn Thử kết nối lại.']
  };
  const [title, message] = messages[reason] || messages.connection;
  document.getElementById('connectionTitle').textContent = title;
  document.getElementById('connectionMessage').textContent = message;
}

document.getElementById('retryConnection').addEventListener('click', () => {
  window.location.reload();
});
window.addEventListener('offline', showConnectionReason);
window.addEventListener('online', () => {
  document.getElementById('connectionMessage').textContent = 'Thiết bị đã có kết nối mạng. Nhấn Thử kết nối lại để mở ứng dụng.';
});
showConnectionReason();
