# Cài Ludy Desktop (Windows & macOS)

Ludy Desktop là ứng dụng nhỏ nằm trên khay hệ thống (Windows) hoặc thanh menu (macOS): đăng nhập một lần qua trình duyệt rồi chạy gọn ở nền. Hướng dẫn tiếng Anh: [install.md](install.md).

> **Hai loại bản cài:**
> - **Bản phát hành chính thức (đã ký số):** tải từ trang phát hành (GitHub Releases có thẻ `desktop-v*` hoặc trang tải của đơn vị vận hành). Bản Windows có chữ ký Authenticode ([signing-runbook.md](signing-runbook.md)); bản macOS được ký Apple Developer ID và chứng thực (notarized) bởi Apple ([mac-signing-runbook.md](mac-signing-runbook.md)) để SmartScreen và Gatekeeper không chặn cảnh báo nhà phát hành lạ.
> - **Bản thử nghiệm CI chưa ký số:** tải từ artifact của workflow `desktop-build` (`ludy-desktop-unsigned-win32-x64` hoặc `ludy-desktop-unsigned-darwin`) để kiểm thử nội bộ. Windows SmartScreen và macOS Gatekeeper sẽ cảnh báo hoặc chặn khi chạy bản chưa ký.

## 1. Tải bản cài và kiểm tra tệp

### Trên Windows (x64)

1. Tải `LudyDesktop-Setup.exe` (và tùy chọn `SHA256SUMS.txt`) từ bản phát hành chính thức.
2. Khuyến nghị kiểm tra mã SHA-256 trong PowerShell trước khi chạy:

```powershell
Get-FileHash .\LudyDesktop-Setup.exe -Algorithm SHA256
```

Đối chiếu kết quả với dòng `LudyDesktop-Setup.exe` trong `SHA256SUMS.txt`.
3. Kiểm tra chữ ký số của trình cài đặt: bấm chuột phải vào `LudyDesktop-Setup.exe`, chọn **Properties -> Digital Signatures** (hoặc chạy `Get-AuthenticodeSignature .\LudyDesktop-Setup.exe` trong PowerShell và kiểm tra `Status` là `Valid`).

### Trên macOS (Apple Silicon `arm64` và Intel `x64`)

1. Chọn đúng tệp `.dmg` theo máy Mac của bạn:
   - Máy Mac chip Apple Silicon (M1, M2, M3, M4 trở lên): `LudyDesktop-<version>-darwin-arm64.dmg`
   - Máy Mac chip Intel: `LudyDesktop-<version>-darwin-x64.dmg`
2. Kiểm tra mã SHA-256 và xác thực Apple Gatekeeper trong Terminal trước khi mở:

```bash
shasum -a 256 LudyDesktop-<version>-darwin-arm64.dmg
spctl -a -t open --context context:primary-signature -vv LudyDesktop-<version>-darwin-arm64.dmg
```

Đối chiếu mã SHA-256 với `SHA256SUMS-darwin-<arch>.txt` và bảo đảm `spctl` trả về `accepted` với `source=Notarized Developer ID`.

### Với bản thử nghiệm CI chưa ký số

1. Mở workflow **desktop-build** trong GitHub Actions và chọn lần chạy xanh trên commit cần thử.
2. Tải `ludy-desktop-unsigned-win32-x64` hoặc `ludy-desktop-unsigned-darwin` (lưu 7 ngày) và giải nén. Chỉ cài trên máy bạn tin cậy.

## 2. Cài đặt và kiểm tra bảo mật

### Trên Windows

1. Bấm đúp `LudyDesktop-Setup.exe`.
2. **Với bản đã ký số:** Windows không hiện chặn nhà phát hành lạ ("Unknown publisher"); nếu SmartScreen hiện hộp xác nhận theo uy tín chứng chỉ mới, hãy kiểm tra đúng tên nhà phát hành rồi tiếp tục cài đặt. (Với bản thử nghiệm CI chưa ký số, chọn **More info -> Run anyway**.)
3. Ứng dụng cài riêng cho tài khoản Windows của bạn (không cần quyền quản trị) vào `%LOCALAPPDATA%\LudyDesktop` rồi tự khởi chạy. Tìm biểu tượng chấm tròn của Ludy Desktop ở vùng thông báo (`Win+B`, phím mũi tên, rồi `Enter`).

### Trên macOS

1. Mở tệp `.dmg` và kéo **Ludy Desktop.app** vào thư mục **Applications**.
2. Mở **Ludy Desktop** từ `/Applications`. Với bản đã ký số và được Apple chứng thực (notarized), macOS mở ứng dụng bình thường mà không hiện cảnh báo "unidentified developer" hay Gatekeeper chặn mở.
3. Có thể kiểm tra lại chữ ký ứng dụng sau khi cài bằng Terminal:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Ludy Desktop.app"
spctl -a -t exec -vv "/Applications/Ludy Desktop.app"
```

4. Biểu tượng chấm tròn của Ludy Desktop sẽ xuất hiện trên thanh menu (góc trên bên phải màn hình macOS).

## 3. Trỏ ứng dụng về Ludy của bạn

Ứng dụng không gắn cứng địa chỉ máy chủ. Hãy cấu hình trước lần đăng nhập đầu tiên bằng biến môi trường hoặc tệp `config.json` (biến môi trường được ưu tiên hơn tệp cấu hình):

- Biến môi trường của người dùng: `LUDY_URL=https://ludy.cong-ty-ban.example` (bắt buộc `https`; chỉ dùng `http://localhost:8080` khi thử trên máy)
- Tệp `config.json`:
  - **Windows:** `%APPDATA%\ludy-desktop\config.json`
  - **macOS:** `~/Library/Application Support/ludy-desktop/config.json`

```json
{
  "ludyUrl": "https://ludy.cong-ty-ban.example",
  "updateUrl": "https://updates.cong-ty-ban.example/ludy-desktop/darwin-arm64"
}
```

(Dùng `.../win32-x64` trên Windows, `.../darwin-arm64` trên Mac Apple Silicon, hoặc `.../darwin-x64` trên Mac Intel.)

Cấu hình tự cập nhật (tùy chọn):

- `LUDY_DESKTOP_UPDATE_URL` (hoặc `"updateUrl"` trong `config.json`): thư mục `https` chứa nguồn cập nhật do đơn vị vận hành cung cấp (hoặc đường dẫn tương đối bắt đầu bằng `/` trên cùng tên miền `LUDY_URL`). Nếu không đặt, tự cập nhật sẽ tắt và menu ghi rõ.
- `LUDY_DESKTOP_UPDATE_ORIGIN` (hoặc `"updateOrigin"`): ghim đúng tên miền gốc của nguồn cập nhật.
- **Windows:** `LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1` (hoặc `"updatePublisherThumbprint"`): mã SHA-1 gồm 40 ký tự hex của chứng chỉ ký phát hành.
- **macOS:** `LUDY_DESKTOP_UPDATE_TEAM_ID` (hoặc `"updateTeamId"`): mã Apple Developer Team ID gồm 10 ký tự chữ và số.
- Khởi động lại Ludy Desktop sau khi thay đổi cấu hình.

## 4. Đăng nhập, quyền ghi âm (macOS) và đăng xuất

- Chọn **Đăng nhập** trên menu để mở trình duyệt tới máy chủ Ludy của bạn. Đăng nhập như bình thường, chọn tổ chức và bấm **Cho phép**. Trình duyệt chuyển về ứng dụng và biểu tượng chuyển màu xanh lá.
- Chọn **Đăng xuất** để xóa phiên đăng nhập trên máy tính này.
- **Quyền ghi âm cuộc họp trên macOS (khi máy chủ bật tính năng):** trên macOS 14.2 trở lên, nếu dùng tính năng ghi cuộc họp, hãy cấp quyền **Microphone** và **System Audio Recording Only** (hoặc Screen & System Audio Recording) trong **System Settings -> Privacy & Security** khi được hỏi. Ứng dụng chỉ ghi sau khi bạn xác nhận thông báo đồng ý và bấm bắt đầu.

Màu sắc biểu tượng:

- Xám: chưa đăng nhập
- Xanh lá: đã đăng nhập
- Đỏ (có chấm trắng khi ghi): đang ghi âm cuộc họp (nếu máy chủ bật tính năng)
- Xanh dương: đã tải xong bản cập nhật, sẵn sàng khởi động lại
- Đỏ trơn: có lỗi (cấu hình sai, đăng nhập bị từ chối, hoặc kiểm tra cập nhật lỗi)

## Mã đăng nhập được lưu ở đâu

Mã đăng nhập chỉ được lưu dưới dạng dữ liệu đã mã hóa bởi hệ điều hành (`safeStorage`: Windows DPAPI hoặc macOS Keychain) trong tệp `session.bin` (`%APPDATA%\ludy-desktop\session.bin` trên Windows, `~/Library/Application Support/ludy-desktop/session.bin` trên macOS). Mã không bao giờ lưu dạng văn bản thường và không bao giờ ghi vào nhật ký. Nếu hệ điều hành không mã hóa được thì phiên chỉ giữ trong bộ nhớ tới khi thoát ứng dụng.

## Ngắt kết nối thiết bị

Trong Ludy web, mở **Cài đặt -> Thiết bị đã kết nối**: máy tính để bàn hiện cạnh các tiện ích trình duyệt kèm thời gian dùng gần nhất. Bấm **Ngắt kết nối** để thu hồi; ứng dụng tự đăng xuất ở lần kiểm tra kế tiếp (tối đa 15 phút hoặc ngay khi mở lại). Chủ sở hữu và quản trị viên có thể thu hồi thiết bị của thành viên khác.

## Tự cập nhật an toàn (từ phiên bản A lên B)

Khi đã cấu hình `LUDY_DESKTOP_UPDATE_URL`:

1. Ứng dụng kiểm tra bản mới lúc khởi động và định kỳ mỗi 6 giờ.
2. Trước khi cài đặt, ứng dụng bắt buộc xác thực nguồn cập nhật phải là `https` công cộng hợp lệ (không chấp nhận địa chỉ mạng nội bộ/SSRF, không chuyển hướng, không tải qua `http` ngoài loopback thử nghiệm), đối chiếu `release-manifest.json` (`signed: true`) và xác thực chữ ký nền tảng (Authenticode + RFC 3161 trên Windows; SHA-256 + kiểm tra cấu trúc ZIP/symlink + `codesign --verify --deep --strict` + Hardened Runtime + Apple Team ID + Gatekeeper `spctl` trên macOS). Nếu nguồn lỗi, chưa ký hoặc sai thông tin, ứng dụng từ chối cập nhật và giữ nguyên phiên bản đang chạy.
3. Khi hợp lệ, bản mới được tải ngầm và menu hiện **Khởi động lại để cập nhật**; ứng dụng không tự tắt giữa chừng khi chưa được bạn chọn.

## Gỡ cài đặt

- **Windows:** Mở **Settings -> Apps -> Ludy Desktop -> Uninstall**.
- **macOS:** Thoát Ludy Desktop từ thanh menu, kéo **Ludy Desktop.app** từ `/Applications` vào **Trash** (Thùng rác), và có thể xóa thêm `~/Library/Application Support/ludy-desktop` nếu muốn dọn cấu hình.
- Nhớ vào **Cài đặt -> Thiết bị đã kết nối** trên Ludy web để thu hồi thiết bị đã gỡ cài đặt.
