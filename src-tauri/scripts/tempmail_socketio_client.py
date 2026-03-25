#!/usr/bin/env python3
"""
TempMail Socket.io 客户端
用于连接 tempmail.cn 获取临时邮箱验证码
"""

import socketio
import time
import sys
import re


def main():
    if len(sys.argv) < 2:
        print("Usage: tempmail_socketio_client.py <shortid> [timeout_seconds]", file=sys.stderr)
        sys.exit(1)

    shortid = sys.argv[1]
    timeout_seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 120

    sio = socketio.Client(reconnection=False)
    code_received = None

    @sio.event
    def connect():
        sio.emit('set shortid', shortid)

    @sio.on('mail')
    def on_mail(mail):
        nonlocal code_received
        text = mail.get('text', '')
        subject = mail.get('headers', {}).get('subject', '')
        full_text = text + ' ' + subject

        # 查找验证码
        patterns = [
            r'Trae\s+(\d{6})',
            r'(?i)verification\s+code.*?\b(\d{6})\b',
            r'\b(\d{6})\b',
        ]
        for pattern in patterns:
            match = re.search(pattern, full_text)
            if match:
                code_received = match.group(1)
                sio.disconnect()
                break

    try:
        sio.connect('https://tempmail.cn', transports=['websocket', 'polling'])
        start = time.time()
        while code_received is None and time.time() - start < timeout_seconds:
            time.sleep(0.1)
        sio.disconnect()

        if code_received:
            print(code_received)
            sys.exit(0)
        else:
            sys.exit(1)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
