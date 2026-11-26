# Cài Ludy Desktop trên Windows

Ludy Desktop là ứng dụng nhỏ nằm trên khay hệ thống của Windows: đăng nhập một lần qua trình duyệt rồi chạy gọn ở vùng thông báo. Hướng dẫn tiếng Anh: [install.md](install.md).

> **Hai loại bản cài:**
> - **Bản phát hành chính thức (đã ký số):** tải từ trang phát hành (GitHub Releases có thẻ `desktop-v*` hoặc trang tải của đơn vị vận hành). Có chữ ký số của nhà phát hành hợp lệ để Windows SmartScreen hiển thị đúng tên nhà phát hành thay vì chặn "Unknown publisher".
> - **Bản thử nghiệm CI chưa ký số:** tải từ artifact **ludy-desktop-unsigned-win32-x64** của workflow `desktop-build` để kiểm thử nội bộ. Windows SmartScreen sẽ cảnh báo khi chạy bản này.

## 1. Tải bản cài và kiểm tra tệp

### Với bản chính thức (đã ký số)

1. Tải `LudyDesktop-Setup.exe` (và tùy chọn `SHA256SUMS.txt`) từ bản phát hành chính thức.
2. Khuyến nghị kiểm tra mã SHA-256 trong PowerShell trước khi chạy:

```powershell
Get-FileHash .\LudyDesktop-Setup.exe -Algorithm SHA256
```

Đối chiếu kết quả với dòng `LudyDesktop-Setup.exe` trong `SHA256SUMS.txt`.
3. Kiểm tra chữ ký số của trình cài đặt: bấm chuột phải vào `LudyDesktop-Setup.exe`, chọn **Properties -> Digital Signatures** (hoặc chạy `Get-AuthenticodeSignature .\LudyDesktop-Setup.exe` trong PowerShell và kiểm tra `Status` là `Valid`).

### Với bản thử nghiệm CI chưa ký số

1. Mở workflow **desktop-build** trong GitHub Actions và chọn lần chạy xanh trên commit cần thử.
2. Tải **ludy-desktop-unsigned-win32-x64** (lưu 7 ngày) và giải nén để lấy `LudyDesktop-Setup.exe`. Chỉ cài trên máy bạn tin cậy.

## 2. Chạy trình cài đặt và kiểm tra SmartScreen

1. Bấm đúp `LudyDesktop-Setup.exe`.
2. **Với bản đã ký số:** Windows không hiện chặn nhà phát hành lạ ("Unknown publisher"); nếu SmartScreen hiện hộp xác nhận theo uy tín chứng chỉ mới, hãy kiểm tra đúng tên nhà phát hành rồi tiếp tục cài đặt. (Với bản thử nghiệm CI chưa ký số, chọn **More info -> Run anyway**.)
3. Ứng dụng cài riêng cho tài khoản Windows của bạn (không cần quyền quản trị) vào `%LOCALAPPDATA%\LudyDesktop` rồi tự khởi chạy. Tìm biểu tượng chấm tròn của Ludy Desktop ở vùng thông báo (`Win+B`, phím mũi tên, rồi `Enter`).

## 3. Trỏ ứng dụng về Ludy của bạn

Ứng dụng không gắn cứng địa chỉ máy chủ. Hãy cấu hình trước lần đăng nhập đầu tiên bằng một trong hai cách (biến môi trường được ưu tiên hơn tệp cấu hình):

- Biến môi trường của người dùng: `LUDY_URL=https://ludy.cong-ty-ban.example` (bắt buộc `https`; chỉ dùng `http://localhost:8080` khi thử trên máy), hoặc
- Tệp `config.json` trong `%APPDATA%\ludy-desktop` với nội dung:

```json
{
  "ludyUrl": "https://ludy.cong-ty-ban.example",
  "updateUrl": "https://updates.cong-ty-ban.example/ludy-desktop/win32-x64"
}
```

Cấu hình tự cập nhật (tùy chọn):

- `LUDY_DESKTOP_UPDATE_URL` (hoặc `"updateUrl"` trong `config.json`): thư mục `https` chứa `RELEASES`, `release-manifest.json` và tệp `.nupkg` do đơn vị vận hành cung cấp (hoặc đường dẫn tương đối bắt đầu bằng `/` trên cùng tên miền `LUDY_URL`). Nếu không đặt, tự cập nhật sẽ tắt và menu khay ghi rõ.
- Tùy chọn ghim bảo mật cho máy quản lý tập trung: `LUDY_DESKTOP_UPDATE_ORIGIN` (hoặc `"updateOrigin"`, ghim đúng tên miền gốc của nguồn cập nhật) và `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` (hoặc `"updatePublisherThumbprint"`, mã SHA-1 gồm 40 ký tự hex của chứng chỉ ký phát hành).
- Khởi động lại Ludy Desktop sau khi thay đổi cấu hình.

## 4. Đăng nhập và đăng xuất

- Chọn **Đăng nhập** trên menu khay để mở trình duyệt tới máy chủ Ludy của bạn. Đăng nhập như bình thường, chọn tổ chức và bấm **Cho phép**. Trình duyệt chuyển về ứng dụng và biểu tượng khay chuyển màu xanh lá.
- Chọn **Đăng xuất** để xóa phiên đăng nhập trên máy tính này.

Mở menu khay bằng cú nhấp chuột, hoặc phím `Enter` / phím Menu khi đang chọn biểu tượng. Màu sắc biểu tượng:

- Xám: chưa đăng nhập
- Xanh lá: đã đăng nhập
- Đỏ (có chấm trắng khi ghi): đang ghi âm cuộc họp (nếu máy chủ bật tính năng)
- Xanh dương: đã tải xong bản cập nhật, sẵn sàng khởi động lại
- Đỏ trơn: có lỗi (cấu hình sai, đăng nhập bị từ chối, hoặc kiểm tra cập nhật lỗi)

## Mã đăng nhập được lưu ở đâu

Mã đăng nhập chỉ được lưu dưới dạng dữ liệu đã mã hóa bởi Windows (DPAPI, qua `safeStorage` của Electron, gắn với tài khoản Windows của bạn) trong `%APPDATA%\ludy-desktop\session.bin`. Mã không bao giờ lưu dạng văn bản thường và không bao giờ ghi vào nhật ký. Nếu Windows không mã hóa được thì phiên chỉ giữ trong bộ nhớ tới khi thoát ứng dụng.

## Ngắt kết nối thiết bị

Trong Ludy web, mở **Cài đặt -> Thiết bị đã kết nối**: máy tính để bàn hiện cạnh các tiện ích trình duyệt kèm thời gian dùng gần nhất. Bấm **Ngắt kết nối** để thu hồi; ứng dụng tự đăng xuất ở lần kiểm tra kế tiếp (tối đa 15 phút hoặc ngay khi mở lại). Chủ sở hữu và quản trị viên có thể thu hồi thiết bị của thành viên khác.

## Tự cập nhật an toàn (từ phiên bản A lên B)

Khi đã cấu hình `LUDY_DESKTOP_UPDATE_URL`:

1. Ứng dụng kiểm tra bản mới lúc khởi động và định kỳ mỗi 6 giờ.
2. Trước khi tải gói cài đặt, ứng dụng bắt buộc xác thực nguồn cập nhật phải là `https` công cộng hợp lệ (không chấp nhận địa chỉ mạng nội bộ/SSRF, không chuyển hướng, không tải qua `http` ngoài loopback thử nghiệm), đối chiếu `RELEASES` khớp với `release-manifest.json` và kiểm tra thông tin bản phát hành đã ký (`signed: true`). Nếu nguồn lỗi, chưa ký hoặc sai thông tin, ứng dụng từ chối cập nhật và giữ nguyên phiên bản đang chạy.
3. Khi hợp lệ, bản mới được tải ngầm và menu khay hiện **Khởi động lại để cập nhật**; ứng dụng không tự tắt giữa chừng khi chưa được bạn chọn.

## Gỡ cài đặt

Mở **Settings -> Apps -> Ludy Desktop -> Uninstall**. Nhớ vào **Cài đặt -> Thiết bị đã kết nối** trên Ludy web để thu hồi thiết bị đã gỡ cài đặt.
