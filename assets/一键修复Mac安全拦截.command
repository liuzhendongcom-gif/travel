#!/bin/bash
# 差旅报销助手 — macOS Gatekeeper 修复脚本
# 双击此文件即可自动移除"已损坏"拦截

APP_NAME="差旅报销助手1.3.app"
APP_PATH="/Applications/$APP_NAME"

echo "====================================="
echo " 差旅报销助手 · macOS 安全拦截修复"
echo "====================================="
echo ""

if [ ! -e "$APP_PATH" ]; then
  echo "❌ 未找到 $APP_PATH"
  echo ""
  echo "请先将应用拖入 Applications（应用程序）文件夹，再运行此脚本。"
  echo ""
  read -p "按回车键关闭..."
  exit 1
fi

echo "正在移除隔离标记..."
xattr -cr "$APP_PATH"

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 修复完成！现在可以直接双击打开应用了。"
  echo ""
  # 自动打开应用
  read -p "是否立即打开应用？(y/n) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    open "$APP_PATH"
  fi
else
  echo ""
  echo "❌ 修复失败，请手动在终端执行："
  echo "   xattr -cr \"$APP_PATH\""
fi

echo ""
read -p "按回车键关闭..."
