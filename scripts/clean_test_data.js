// Intentionally disabled: the previous script could erase real financial data.
// Do not load server.js, .env, pg, or any application state here.
console.error('DISABLED: Không được xóa dữ liệu tài chính bằng script này. Chỉ dọn database thử nghiệm riêng do test harness tạo và sở hữu.');
process.exitCode = 1;
