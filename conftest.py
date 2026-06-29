import pytest


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: 需要公网联网的集成测试")
    config.addinivalue_line("markers", "pc: PC 版本 .app 可用性测试（需先 build）")