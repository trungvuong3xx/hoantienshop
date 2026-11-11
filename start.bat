@echo off
chcp 65001 >nul
title AffConvert - Shopee & TikTok Affiliate Link Converter
echo ========================================================
echo   Dang khoi dong Web App AffConvert tại:
echo   http://localhost:3456
echo ========================================================
start http://localhost:3456
node server.js
pause
