#!/usr/bin/env python3
"""
构建 TempMail Socket.io 客户端可执行文件
"""

import subprocess
import sys
import os
import shutil
import platform


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    print("Installing dependencies...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], check=True)

    print("Building executable with PyInstaller...")

    # PyInstaller 配置
    pyinstaller_args = [
        "pyinstaller",
        "--onefile",  # 打包成单个文件
        "--name", "tempmail_socketio_client",
        "--clean",
        "--noconfirm",
        "--distpath", "../bin",
        "--workpath", "./build",
        "--specpath", "./build",
    ]

    # Windows 下隐藏控制台窗口
    if platform.system() == "Windows":
        pyinstaller_args.append("--windowed")
        pyinstaller_args.append("--hide-console")
        pyinstaller_args.append("hide-early")

    pyinstaller_args.append("tempmail_socketio_client.py")

    subprocess.run(pyinstaller_args, check=True)

    # 清理临时文件
    if os.path.exists("./build"):
        shutil.rmtree("./build")

    print(f"\nBuild complete!")
    print(f"Executable location: {os.path.join(script_dir, '../bin/tempmail_socketio_client')}")


if __name__ == "__main__":
    main()
