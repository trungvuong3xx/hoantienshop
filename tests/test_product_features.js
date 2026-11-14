const assert = require('assert');
const express = require('express');
const { registerCashbackRoutes } = require('../src/services/cashbackController');
const { ensureDbLoaded } = require('../src/services/dbService');

async function runProductFeaturesTest() {
  console.log('=== TEST SUITE: PRODUCT PREVIEW, IMAGE, PRICE & CASHBACK ===');

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Test /api/preview
    console.log('\n--- 1. Testing /api/preview with real Shopee link ---');
    const previewRes = await fetch(`${baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://s.shopee.vn/6q2DPhkHB9' })
    });
    assert.strictEqual(previewRes.status, 200, 'Preview HTTP status must be 200');
    const previewData = await previewRes.json();
    console.log('Preview Result:', {
      found: previewData.found,
      title: previewData.title?.slice(0, 40),
      productName: previewData.productName?.slice(0, 40),
      price: previewData.price,
      estimatedCashback: previewData.estimatedCashback,
      imageUrl: previewData.imageUrl?.slice(0, 50)
    });

    assert.strictEqual(previewData.found, true, 'Product must be found');
    assert.ok(previewData.productName && !previewData.productName.startsWith('Sản phẩm Shopee #'), 'Must have real product name');
    assert.strictEqual(previewData.productName, previewData.title, 'title and productName must match');
    assert.ok(previewData.imageUrl && previewData.imageUrl.startsWith('https://'), 'Must have valid https image url');
    assert.ok(previewData.price > 0, `Price must be > 0 (got ${previewData.price})`);
    assert.ok(previewData.estimatedCashback > 0, `Estimated cashback must be > 0 (got ${previewData.estimatedCashback})`);
    console.log('  PASS: /api/preview returns rich product title, image, price and estimated cashback.');

    // 2. Test /api/convert
    console.log('\n--- 2. Testing /api/convert with real Shopee link ---');
    const convertRes = await fetch(`${baseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'https://s.shopee.vn/6q2DPhkHB9' })
    });
    assert.strictEqual(convertRes.status, 200, 'Convert HTTP status must be 200');
    const convertData = await convertRes.json();
    const item = convertData.items?.[0];
    assert.ok(item, 'Must have at least 1 converted item');
    console.log('Convert Item Result:', {
      status: item.status,
      title: item.title?.slice(0, 40),
      productName: item.productName?.slice(0, 40),
      price: item.price,
      estimatedCashback: item.estimatedCashback,
      imageUrl: item.imageUrl?.slice(0, 50)
    });

    assert.strictEqual(item.status, 'success', 'Item status must be success');
    assert.ok(item.productName && !item.productName.startsWith('Sản phẩm Shopee #'), 'Must have real product name');
    assert.strictEqual(item.productName, item.title, 'Item title and productName must match');
    assert.ok(item.imageUrl && item.imageUrl.startsWith('https://'), 'Item must have valid https image url');
    assert.ok(item.price > 0, `Item price must be > 0 (got ${item.price})`);
    assert.ok(item.estimatedCashback > 0, `Item estimated cashback must be > 0 (got ${item.estimatedCashback})`);
    console.log('  PASS: /api/convert returns rich product title, image, price and estimated cashback.');

    console.log('\n=== ALL PRODUCT FEATURE TESTS PASSED CLEANLY! ===\n');
  } finally {
    server.close();
  }
}

runProductFeaturesTest().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
