const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  cleanExpiredClicks,
  addClickRecord,
  CLICK_TTL_MS,
  MAX_CLICKS_HARD_LIMIT
} = require('../src/utils/clickManager');

const expect = (actual) => ({
  toBe: (expected) => assert.strictEqual(actual, expected),
  toEqual: (expected) => assert.deepStrictEqual(actual, expected),
  toBeTruthy: () => assert.ok(actual),
  toBeFalsy: () => assert.ok(!actual),
  toBeGreaterThan: (expected) => assert.ok(actual > expected),
  toBeLessThanOrEqual: (expected) => assert.ok(actual <= expected)
});

describe('Click TTL and Retention', () => {
  test('retains newly added clicks and removes clicks older than 30 days', () => {
    const now = Date.now();
    const mockClicks = [
      { clickId: 'old_1', createdAt: new Date(now - 31 * 86400000).toISOString() },
      { clickId: 'recent_1', createdAt: new Date(now - 2 * 86400000).toISOString() }
    ];
    const cleaned = cleanExpiredClicks(mockClicks, now);
    expect(cleaned.some((c) => c.clickId === 'old_1')).toBe(false);
    expect(cleaned.some((c) => c.clickId === 'recent_1')).toBe(true);
    expect(cleaned.length).toBe(1);
  });

  test('preserves clicks within 30-day boundary and drops beyond boundary', () => {
    const now = Date.now();
    const mockClicks = [
      { clickId: 'just_expired', createdAt: new Date(now - (CLICK_TTL_MS + 1000)).toISOString() },
      { clickId: 'boundary_valid', createdAt: new Date(now - (CLICK_TTL_MS - 5000)).toISOString() },
      { clickId: 'brand_new', createdAt: new Date(now).toISOString() }
    ];
    const cleaned = cleanExpiredClicks(mockClicks, now);
    expect(cleaned.length).toBe(2);
    expect(cleaned.map((c) => c.clickId)).toEqual(['boundary_valid', 'brand_new']);
  });

  test('filters out clicks with invalid, corrupt, or missing createdAt', () => {
    const now = Date.now();
    const mockClicks = [
      { clickId: 'valid_1', createdAt: new Date(now - 1000).toISOString() },
      { clickId: 'invalid_date', createdAt: 'not-a-valid-date' },
      { clickId: 'no_created_at' },
      null,
      undefined
    ];
    const cleaned = cleanExpiredClicks(mockClicks, now);
    expect(cleaned.length).toBe(1);
    expect(cleaned[0].clickId).toBe('valid_1');
  });

  test('handles null, undefined, or non-array inputs gracefully', () => {
    expect(cleanExpiredClicks(null)).toEqual([]);
    expect(cleanExpiredClicks(undefined)).toEqual([]);
    expect(cleanExpiredClicks('string')).toEqual([]);
    expect(cleanExpiredClicks({})).toEqual([]);
    expect(cleanExpiredClicks([])).toEqual([]);
  });

  test('enforces MAX_CLICKS_HARD_LIMIT (20,000) cap to prevent memory exhaustion', () => {
    const now = Date.now();
    const overflowCount = MAX_CLICKS_HARD_LIMIT + 500;
    const largeList = [];
    for (let i = 0; i < overflowCount; i++) {
      largeList.push({
        clickId: `click_${i}`,
        createdAt: new Date(now - (i * 10)).toISOString()
      });
    }
    const cleaned = cleanExpiredClicks(largeList, now);
    expect(cleaned.length).toBe(MAX_CLICKS_HARD_LIMIT);
    expect(cleaned[0].clickId).toBe('click_0');
  });

  test('addClickRecord prepends new click and purges expired records', () => {
    const now = Date.now();
    const clicks = [
      { clickId: 'old_expired', createdAt: new Date(now - 35 * 86400000).toISOString() },
      { clickId: 'existing_valid', createdAt: new Date(now - 86400000).toISOString() }
    ];

    const updated = addClickRecord(clicks, {
      clickId: 'new_entry',
      userCode: 'GUEST',
      platform: 'shopee',
      affiliateUrl: 'https://shope.ee/test'
    });

    expect(updated[0].clickId).toBe('new_entry');
    expect(updated[0].userCode).toBe('GUEST');
    expect(Boolean(updated[0].createdAt)).toBe(true);
    expect(updated.some((c) => c.clickId === 'old_expired')).toBe(false);
    expect(updated.some((c) => c.clickId === 'existing_valid')).toBe(true);
    expect(updated.length).toBe(2);
  });

  test('preserves guest clicks with affiliateUrl for /go/:clickId redirect support', () => {
    const now = Date.now();
    const clicks = [];
    addClickRecord(clicks, {
      clickId: 'guest_clk_123',
      userId: null,
      userCode: 'GUEST',
      platform: 'shopee',
      originalUrl: 'https://shopee.vn/product/123',
      cleanUrl: 'https://shopee.vn/product/123',
      affiliateUrl: 'https://s.shopee.vn/aff_target_123'
    });

    expect(clicks.length).toBe(1);
    const found = clicks.find((c) => c.clickId === 'guest_clk_123');
    expect(Boolean(found)).toBe(true);
    expect(found.affiliateUrl).toBe('https://s.shopee.vn/aff_target_123');
    expect(found.userCode).toBe('GUEST');
  });
});
