const logger = require('../utils/logger');

const ALLOWED_ORDER_TRANSITIONS = {
  pending: ['approved', 'cancelled'],
  approved: ['cancelled'],
  cancelled: ['approved']
};

/**
 * Parse various timestamp formats (epoch seconds/ms, Date, ISO strings) into epoch milliseconds.
 */
function parseTimestamp(val) {
  if (!val) return 0;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0;
    return val < 1e11 ? val * 1000 : val;
  }
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  const str = String(val).trim();
  const num = Number(str);
  if (Number.isFinite(num) && !str.includes('-') && !str.includes('T')) {
    return num < 1e11 ? num * 1000 : num;
  }
  const parsed = new Date(str).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Validate whether an order status transition is allowed and chronologically newer.
 */
function canTransitionOrderStatus(from, to, { fromEventTime = 0, currentStatusUpdatedAt = 0 } = {}) {
  if (!from) return true;
  if (from === to) return true;
  const allowed = Boolean(ALLOWED_ORDER_TRANSITIONS[from]?.includes(to));
  if (!allowed) {
    logger.warning('canTransitionOrderStatus', 'Bỏ qua chuyển đổi trạng thái không hợp lệ', {
      from,
      to
    });
    return false;
  }
  if (fromEventTime && currentStatusUpdatedAt && fromEventTime < currentStatusUpdatedAt) {
    logger.warning('canTransitionOrderStatus', 'Bỏ qua sự kiện cũ hơn trạng thái hiện tại', {
      from,
      to,
      fromEventTime,
      currentStatusUpdatedAt
    });
    return false;
  }
  return true;
}

/**
 * Strip internal financial margins and claim audit fields before returning an order to end users.
 */
function sanitizeOrderForUser(o) {
  if (!o) return null;
  return {
    id: o.id,
    orderSn: o.orderSn,
    platform: o.platform,
    productName: o.productName,
    orderAmount: o.orderAmount,
    cashbackRate: o.cashbackRate,
    userCashbackAmount: o.userCashbackAmount,
    status: o.status,
    claimPending: Boolean(o.claimPending),
    claimVerified: Boolean(o.claimVerified),
    claimRejected: Boolean(o.claimRejected),
    claimRejectReason: o.claimRejectReason || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  };
}

/**
 * Normalize network-specific raw order statuses into pending | approved | cancelled.
 */
function normalizeNetworkStatus(rawStatus) {
  const s = String(rawStatus ?? '').trim().toUpperCase();
  if (
    s === '1' ||
    s === 'COMPLETED' ||
    s === 'APPROVED' ||
    s.endsWith('_COMPLETED') ||
    s.endsWith('_APPROVED') ||
    s.includes('HOÀN THÀNH') ||
    s.includes('ĐÃ DUYỆT')
  ) {
    return 'approved';
  }
  if (
    s === '2' ||
    s === '-1' ||
    s === 'CANCELLED' ||
    s === 'CANCELED' ||
    s === 'INVALID' ||
    s === 'REJECTED' ||
    s.endsWith('_CANCELLED') ||
    s.endsWith('_CANCELED') ||
    s.includes('HUỶ') ||
    s.includes('HỦY')
  ) {
    return 'cancelled';
  }
  if (
    s === '0' ||
    s === 'PENDING' ||
    s === 'PROCESSING' ||
    s === 'NEW' ||
    s === 'UNPAID' ||
    s.endsWith('_PENDING') ||
    s.endsWith('_UNPAID') ||
    s.includes('CHỜ')
  ) {
    return 'pending';
  }
  logger.warning('normalizeNetworkStatus', 'Trạng thái sàn không khớp whitelist, gán mặc định pending', {
    rawStatus
  });
  return 'pending';
}

/**
 * Sanitize any numeric input to a finite number, defaulting to defaultVal if NaN or non-finite.
 */
function sanitizeFiniteNumber(val, defaultVal = 0) {
  if (val === null || val === undefined || val === '') return defaultVal;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : defaultVal;
  }
  const str = String(val).replace(/,/g, '').trim();
  if (!str) return defaultVal;
  const num = Number(str);
  return Number.isFinite(num) ? num : defaultVal;
}

/**
 * Parse Shopee conversion nodes adhering to Shopee Open API v2 and Affiliate GraphQL schemas.
 * Strictly eliminates arbitrary equal-split fallbacks and preserves actual order total commissions.
 * Sanitizes all numeric fields with Number.isFinite.
 */
function parseShopeeReportNodes(reportNodes) {
  logger.logEnter('parseShopeeReportNodes', {
    count: Array.isArray(reportNodes) ? reportNodes.length : (reportNodes ? 1 : 0)
  });

  if (!reportNodes) {
    logger.logLeave('parseShopeeReportNodes', { parsedCount: 0 });
    return [];
  }

  const nodes = Array.isArray(reportNodes) ? reportNodes : [reportNodes];
  const results = [];

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;

    try {
      const rawSubId = String(
        node.utm_content ??
        node.utmContent ??
        node.sub_id_1 ??
        node.sub_id1 ??
        node.sub1 ??
        node.subId1 ??
        node.subId ??
        ''
      ).split('-')[0].trim();

      const nodeGrossComm = sanitizeFiniteNumber(
        node.total_commission ??
        node.totalCommission ??
        node.net_commission ??
        node.netCommission ??
        node.commission ??
        node.actual_amount ??
        node.actualAmount,
        0
      );

      const nodePurchaseTime =
        node.purchase_time ??
        node.purchaseTime ??
        node.create_time ??
        node.createTime ??
        node.order_time ??
        node.orderTime ??
        null;

      let subOrders = [];
      if (Array.isArray(node.orders) && node.orders.length > 0) {
        subOrders = node.orders;
      } else if (Array.isArray(node.order_list) && node.order_list.length > 0) {
        subOrders = node.order_list;
      } else if (Array.isArray(node.sub_orders) && node.sub_orders.length > 0) {
        subOrders = node.sub_orders;
      } else if (
        node.purchase_order_id ||
        node.purchaseOrderId ||
        node.order_sn ||
        node.orderSn ||
        node.order_id ||
        node.orderId
      ) {
        subOrders = [node];
      }

      if (subOrders.length === 0) continue;

      const orderCandidates = [];

      for (const ord of subOrders) {
        if (!ord || typeof ord !== 'object') continue;

        const orderSn = String(
          ord.purchase_order_id ??
          ord.purchaseOrderId ??
          ord.order_sn ??
          ord.orderSn ??
          ord.order_id ??
          ord.orderId ??
          (subOrders.length === 1 ? (node.conversion_id ?? node.conversionId ?? '') : '')
        ).trim().toUpperCase();

        if (!orderSn) continue;

        const rawStatus =
          ord.order_status ??
          ord.orderStatus ??
          ord.purchase_order_status ??
          ord.purchaseOrderStatus ??
          node.order_status ??
          node.orderStatus ??
          node.purchase_order_status ??
          node.purchaseOrderStatus;
        const status = normalizeNetworkStatus(rawStatus);

        const ordSubId = String(
          ord.sub_id_1 ??
          ord.sub_id1 ??
          ord.sub1 ??
          ord.subId1 ??
          ord.subId ??
          ord.utm_content ??
          ord.utmContent ??
          rawSubId
        ).split('-')[0].trim();

        const purchaseTime =
          ord.purchase_time ??
          ord.purchaseTime ??
          ord.create_time ??
          ord.createTime ??
          ord.order_time ??
          ord.orderTime ??
          nodePurchaseTime;

        const rawItems = Array.isArray(ord.item_list)
          ? ord.item_list
          : Array.isArray(ord.itemList)
          ? ord.itemList
          : Array.isArray(ord.items)
          ? ord.items
          : Array.isArray(ord.order_items)
          ? ord.order_items
          : Array.isArray(ord.orderItems)
          ? ord.orderItems
          : (subOrders.length === 1 && (
              Array.isArray(node.item_list) ? node.item_list :
              Array.isArray(node.items) ? node.items :
              Array.isArray(node.order_items) ? node.order_items : []
            )) || [];

        let itemsTotalAmount = 0;
        let sumItemComm = 0;
        let hasItemBreakdown = false;
        const itemNames = [];

        for (const it of rawItems) {
          if (!it || typeof it !== 'object') continue;
          const name = it.item_name ?? it.itemName ?? it.product_name ?? it.productName ?? it.name;
          if (name) itemNames.push(name);

          const price = Math.max(0, sanitizeFiniteNumber(it.item_price ?? it.itemPrice ?? it.price, 0));
          const rawQty = it.qty ?? it.quantity ?? it.item_count ?? it.itemCount ?? it.count;
          const qty = rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== ''
            ? Math.max(1, sanitizeFiniteNumber(rawQty, 1))
            : 1;
          itemsTotalAmount += (price * qty);

          const rawComm = it.item_commission ?? it.itemCommission ?? it.commission;
          if (rawComm !== undefined && rawComm !== null && String(rawComm).trim() !== '') {
            hasItemBreakdown = true;
            sumItemComm += Math.max(0, sanitizeFiniteNumber(rawComm, 0));
          }
        }

        const rawOrdAmount =
          ord.total_order_amount ??
          ord.totalOrderAmount ??
          ord.order_amount ??
          ord.orderAmount ??
          ord.gmv ??
          ord.total_amount ??
          ord.totalAmount;

        let orderAmount = 0;
        if (rawOrdAmount !== undefined && rawOrdAmount !== null && String(rawOrdAmount).trim() !== '') {
          orderAmount = Math.max(0, sanitizeFiniteNumber(rawOrdAmount, 0));
        } else if (itemsTotalAmount > 0) {
          orderAmount = itemsTotalAmount;
        } else if (subOrders.length === 1) {
          const rawNodeAmount =
            node.total_order_amount ??
            node.totalOrderAmount ??
            node.order_amount ??
            node.orderAmount ??
            node.gmv ??
            node.total_amount ??
            node.totalAmount;
          if (rawNodeAmount !== undefined && rawNodeAmount !== null && String(rawNodeAmount).trim() !== '') {
            orderAmount = Math.max(0, sanitizeFiniteNumber(rawNodeAmount, 0));
          }
        }
        orderAmount = Math.max(0, sanitizeFiniteNumber(orderAmount, 0));

        const rawProductName = itemNames.length > 0
          ? itemNames.join(', ')
          : (ord.product_name ?? ord.productName ?? node.product_name ?? node.productName ?? `Đơn Shopee #${orderSn}`);
        const productName = String(rawProductName).slice(0, 150);

        const rawOrdComm =
          ord.total_commission ??
          ord.totalCommission ??
          ord.commission ??
          ord.net_commission ??
          ord.netCommission ??
          ord.actual_amount ??
          ord.actualAmount;

        const hasDirectOrdComm = rawOrdComm !== undefined && rawOrdComm !== null && String(rawOrdComm).trim() !== '';
        let explicitComm = null;

        if (hasDirectOrdComm) {
          const parsedOrdComm = Math.max(0, sanitizeFiniteNumber(rawOrdComm, 0));
          if (parsedOrdComm > 0) {
            explicitComm = parsedOrdComm;
          } else if (hasItemBreakdown && sumItemComm > 0) {
            explicitComm = sumItemComm;
          } else {
            explicitComm = 0;
          }
        } else if (hasItemBreakdown) {
          explicitComm = Math.max(0, sanitizeFiniteNumber(sumItemComm, 0));
        }

        orderCandidates.push({
          orderSn,
          rawSubId: ordSubId,
          status,
          purchaseTime,
          orderAmount,
          productName,
          explicitComm,
          hasItemBreakdown
        });
      }

      const activeWithoutComm = orderCandidates.filter(
        (o) => o.status !== 'cancelled' && o.explicitComm === null
      );
      const sumExplicitComm = orderCandidates.reduce(
        (sum, o) => sum + (o.explicitComm !== null ? o.explicitComm : 0),
        0
      );
      const remainingNodeComm = Math.max(0, nodeGrossComm - sumExplicitComm);
      const totalAmountWithoutComm = activeWithoutComm.reduce(
        (sum, o) => sum + o.orderAmount,
        0
      );

      for (const o of orderCandidates) {
        let grossCommission = 0;
        let isEstimated = false;

        if (o.explicitComm !== null) {
          grossCommission = o.explicitComm;
          isEstimated = false;
        } else if (o.status === 'cancelled') {
          grossCommission = 0;
          isEstimated = false;
        } else if (remainingNodeComm > 0) {
          if (activeWithoutComm.length === 1) {
            grossCommission = remainingNodeComm;
            isEstimated = true;
          } else if (totalAmountWithoutComm > 0) {
            grossCommission = Math.round(remainingNodeComm * (o.orderAmount / totalAmountWithoutComm));
            isEstimated = true;
            logger.log('parseShopeeReportNodes', 'Phân bổ hoa hồng node theo tỷ lệ giá trị đơn', {
              orderSn: o.orderSn,
              grossCommission,
              commissionEstimated: true
            });
          } else {
            grossCommission = 0;
            isEstimated = true;
            logger.warning('parseShopeeReportNodes', 'Bỏ qua chia đều tùy tiện khi không có giá trị đơn và chi tiết hoa hồng', {
              orderSn: o.orderSn,
              remainingNodeComm
            });
          }
        }

        grossCommission = Math.max(0, sanitizeFiniteNumber(grossCommission, 0));
        const finalOrderAmount = Math.max(0, sanitizeFiniteNumber(o.orderAmount, 0));

        results.push({
          orderSn: o.orderSn,
          rawSubId: o.rawSubId,
          grossCommission,
          orderAmount: finalOrderAmount,
          status: o.status,
          platform: 'shopee',
          productName: o.productName,
          commissionEstimated: isEstimated,
          purchaseTime: o.purchaseTime
        });
      }
    } catch (nodeErr) {
      logger.warning('parseShopeeReportNodes', 'Lỗi xử lý node báo cáo Shopee', { error: nodeErr.message });
    }
  }

  logger.logLeave('parseShopeeReportNodes', { parsedCount: results.length });
  return results;
}

module.exports = {
  ALLOWED_ORDER_TRANSITIONS,
  parseTimestamp,
  canTransitionOrderStatus,
  sanitizeOrderForUser,
  normalizeNetworkStatus,
  sanitizeFiniteNumber,
  parseShopeeReportNodes
};
