/* Shared CSV reader: used by the browser and executable regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CashbackCsv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const key = value => String(value || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');

  function readRecords(text) {
    text = String(text).replace(/^\uFEFF/, '');
    const header = text.split(/\r?\n/, 1)[0];
    const delimiter = (header.match(/;/g) || []).length > (header.match(/,/g) || []).length ? ';' : ',';
    const records = []; let row = [], cell = '', quoted = false, closed = false;
    const pushCell = () => { row.push(cell.trim()); cell = ''; closed = false; };
    const pushRow = () => { pushCell(); if (row.some(v => v !== '')) records.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; }
        else cell += c;
      } else if (c === delimiter) pushCell();
      else if (c === '\r' || c === '\n') { pushRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
      else if (c === '"' && cell.trim() === '' && !closed) { cell = ''; quoted = true; }
      else if (closed && /\s/.test(c)) continue;
      else if (closed || c === '"') throw new Error('CSV có dấu nháy không hợp lệ.');
      else cell += c;
    }
    if (quoted) throw new Error('CSV thiếu dấu nháy đóng.');
    if (cell || row.length || closed) pushRow();
    return records;
  }

  function money(raw, column) {
    let s = String(raw ?? '').trim().replace(/(?:VND|₫|đ|\s)/gi, '');
    if (!s || !/^[0-9]+(?:[.,][0-9]+)*$/.test(s)) throw new Error(`Giá trị không hợp lệ ở cột ${column}.`);
    const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      const decimal = dot > comma ? '.' : ',', thousands = decimal === '.' ? ',' : '.';
      const parts = s.split(decimal);
      if (parts.length !== 2 || !/^\d{1,4}$/.test(parts[1])) throw new Error(`Số tiền không rõ định dạng ở cột ${column}.`);
      const groups = parts[0].split(thousands);
      if (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(v => !/^\d{3}$/.test(v)))) throw new Error(`Phân cách hàng nghìn không hợp lệ: ${column}.`);
      s = groups.join('') + '.' + parts[1];
    } else if (dot >= 0 || comma >= 0) {
      const sep = dot >= 0 ? '.' : ',';
      const parts = s.split(sep);
      if (parts.length > 2) {
        if (/^\d{1,3}$/.test(parts[0]) && parts.slice(1).every(v => /^\d{3}$/.test(v))) s = parts.join('');
        else throw new Error(`Phân cách hàng nghìn không hợp lệ: ${column}.`);
      } else if (parts.length === 2) {
        if (parts[1].length <= 4 && (parts[1].length !== 3 || parts[0].length > 3)) {
          s = parts.join('.');
        } else if (/^\d{1,3}$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
          s = parts.join('');
        } else {
          throw new Error(`Số tiền không rõ định dạng ở cột ${column}.`);
        }
      } else {
        throw new Error(`Số tiền không rõ định dạng ở cột ${column}.`);
      }
    }
    const value = Number(s);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) throw new Error(`Số tiền vượt giới hạn: ${column}.`);
    return value;
  }

  function statusOf(value) {
    const status = String(value || '').trim().toLowerCase();
    if (['1', 'hoàn thành', 'đã hoàn thành', 'completed', 'approved', 'đã duyệt', 'đã thanh toán'].includes(status)) return 'approved';
    if (['2', '-1', 'đã hủy', 'đã huỷ', 'hủy', 'huỷ', 'cancelled', 'canceled', 'rejected'].includes(status)) return 'cancelled';
    if (['0', 'pending', 'unpaid', 'chờ duyệt', 'đang chờ', 'đang chờ xử lý', 'chưa thanh toán', 'đang xử lý', 'đang giao', 'đang giao hàng'].includes(status)) return 'pending';
    throw new Error('Trạng thái CSV chưa được hỗ trợ: ' + (status || '(trống)'));
  }

  function reportTime(filename) {
    const match = /^AffiliateCommissionReport_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*\(\d+\))?\.csv$/i.exec(filename || '');
    if (!match) return null;
    const [, y, m, d, h, min] = match;
    const iso = `${y}-${m}-${d}T${h}:${min}:00+07:00`;
    const time = Date.parse(iso);
    if (!Number.isFinite(time) || new Date(time + 7 * 3600000).toISOString().slice(0, 16) !== `${y}-${m}-${d}T${h}:${min}`) throw new Error('Ngày xuất báo cáo trong tên file không hợp lệ.');
    return time;
  }

  function parse(text, filename = '') {
    const records = readRecords(text);
    if (records.length < 2) throw new Error('File CSV không có dữ liệu.');
    const headers = records[0].map(key);
    if (new Set(headers).size !== headers.length) throw new Error('CSV có tiêu đề cột trùng nhau.');
    const index = aliases => aliases.map(key).map(k => headers.indexOf(k)).find(i => i >= 0);
    const columns = {
      orderSn: index(['ID đơn hàng', 'Mã đơn hàng', 'order id', 'order_id', 'conversion_id', 'transaction_id', 'orderSn']),
      status: index(['Trạng thái đặt hàng', 'Trạng thái đơn hàng', 'order status', 'status', 'trạng thái']),
      commission: index(['Tổng hoa hồng đơn hàng(₫)', 'total commission', 'pub_commission', 'hoa hồng', 'reward']),
      amount: index(['Giá trị đơn hàng (₫)', 'billing', 'total_amount', 'order amount']),
      attribution: index(['Sub_id1', 'sub id 1', 'sub_id', 'sub1', 'utm_source']),
      platform: index(['merchant', 'chiến dịch', 'platform']),
      product: index(['Tên Item', 'productName', 'product_name']),
      itemStatus: index(['Trạng thái sản phẩm liên kết']),
      mcnFee: index(['Phí quản lý MCN(₫)'])
    };
    for (const field of ['orderSn', 'status', 'commission', 'amount']) if (columns[field] === undefined) throw new Error('CSV thiếu cột bắt buộc: ' + field);
    const groups = new Map(); let duplicateRows = 0;
    const eventTime = reportTime(filename);
    for (let i = 1; i < records.length; i++) {
      const cells = records[i];
      if (cells.length !== headers.length) throw new Error(`Dòng ${i + 1}: số cột không khớp tiêu đề.`);
      const val = field => cells[columns[field]] || '';
      try {
        const orderSn = val('orderSn').toUpperCase();
        if (orderSn.length < 2 || orderSn.length > 64 || !/^[A-Z0-9_.-]+$/.test(orderSn)) throw new Error('Mã đơn không hợp lệ.');
        const status = statusOf(val('status'));
        if (columns.itemStatus !== undefined && statusOf(val('itemStatus')) !== status) throw new Error('Trạng thái đơn và sản phẩm khác nhau; cần đối soát riêng.');
        if (columns.mcnFee !== undefined && money(val('mcnFee'), 'Phí quản lý MCN') !== 0) throw new Error('Đơn có phí MCN; cần xác nhận cơ sở chia hoa hồng trước khi nhập.');
        const merchant = val('platform').toLowerCase();
        const row = {
          orderSn, status, platform: merchant.includes('tiktok') ? 'tiktok' : 'shopee',
          userCode: val('attribution') || 'GUEST',
          totalCommission: money(val('commission'), 'Tổng hoa hồng đơn hàng'),
          orderAmount: money(val('amount'), 'Giá trị đơn hàng'),
          productName: val('product').slice(0, 150), eventTime
        };
        const groupKey = JSON.stringify([row.platform, orderSn]);
        const old = groups.get(groupKey);
        if (old) {
          if (['status', 'userCode', 'totalCommission', 'orderAmount'].some(k => old[k] !== row[k])) throw new Error('Các dòng cùng mã đơn có trạng thái, chủ đơn hoặc tổng tiền khác nhau; không thể tự gộp.');
          duplicateRows++;
        } else groups.set(groupKey, row);
      } catch (error) { throw new Error(`Dòng ${i + 1}: ${error.message}`); }
    }
    const rows = [...groups.values()];
    return { rows, sourceRows: records.length - 1, duplicateRows, totalEstComm: rows.reduce((sum, r) => sum + r.totalCommission, 0) };
  }
  return { parse, readRecords, money, reportTime };
});
