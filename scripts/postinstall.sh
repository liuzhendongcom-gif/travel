#!/bin/bash
# 安装后自动移除 macOS Gatekeeper 隔离标记
# 通过 LaunchAgent 在用户登录后立即执行，避免"已损坏"提示

APP="/Applications/差旅报销助手1.2.app"
LABEL="com.travelreimbursement.fixgatekeeper"
PLIST="/Library/LaunchAgents/${LABEL}.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>xattr -cr "${APP}"; rm -f "${PLIST}"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

chmod 644 "$PLIST"
launchctl load "$PLIST" 2>/dev/null

exit 0
