# Codex Usage & Reset (Local)

Hiển thị quota Codex (5h và 7d), giờ reset theo Việt Nam (UTC+7) và trạng thái màu trực tiếp trên status bar của VS Code.

- Đọc quota qua `codex app-server` (kết nối giữ sẵn, cập nhật realtime).
- Theo dõi `auth.json` để tự cập nhật khi đổi tài khoản Codex.
- Không gửi model turn nào, không tốn quota.

## Cài đặt (một lệnh)

Yêu cầu: VS Code, Node.js 18+, đã đăng nhập Codex (extension OpenAI ChatGPT hoặc Codex app).

```bash
git clone https://github.com/HongThinhThinh/codex-usage-statusbar.git
cd codex-usage-statusbar
npm run install:local
```

Sau đó trong VS Code chạy `Developer: Reload Window`.

Trên máy khác đã clone rồi thì chỉ cần `git pull && npm run install:local`.

## Cấu hình

| Setting | Mặc định | Ghi chú |
|---|---|---|
| `localCodexUsage.codexExecutablePath` | `auto` | Tự dò Codex: Codex app, extension `openai.chatgpt-*` trong `~/.vscode` / `~/.cursor`, rồi `codex` trên PATH. Chỉ đặt đường dẫn tuyệt đối khi dò sai. |
| `localCodexUsage.refreshIntervalSeconds` | `5` | `0` tắt polling nền. |
| `localCodexUsage.statusBarIcon` | `dashboard` | `none` để ẩn icon. |

Biến môi trường `CODEX_HOME` được tôn trọng khi tìm `auth.json` (mặc định `~/.codex`).

## Kiểm tra

```bash
npm test
```

`test/realtime.cjs` cần một binary Codex thật. Nếu `codex` không có trên PATH:

```bash
CODEX_EXECUTABLE="/đường/dẫn/tới/codex" npm test
```

## Lệnh trong Command Palette

- `Codex Quota: Refresh`
- `Codex Quota: Show Details`
- `Codex Quota: Set Refresh Interval`
- `Codex Quota: Open Settings`
- `Codex Quota: Open Usage Page`
