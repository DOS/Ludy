# Cài Ludy Desktop (bản thử nghiệm)

Ludy Desktop là một ứng dụng nhỏ trên khay hệ thống của Windows: đăng nhập một lần rồi nó nằm ở vùng thông báo. Ở phiên bản này nó **không ghi âm gì cả**; nó là phần vỏ để các phiên bản sau thêm tính năng ghi cuộc họp ([ADR-0055](../adr/0055-three-capture-paths-one-meeting.md)). Bản tiếng Anh: [install.md](install.md).

> **Đây là bản thử nghiệm chưa ký số.** Chưa có chứng chỉ ký phần mềm (chủ sở hữu chưa mua, xem [signing-runbook.md](signing-runbook.md)), nên Windows sẽ cảnh báo khi bạn chạy. Chỉ cài trên máy bạn tin cậy, và chỉ cài bản chính bạn tải từ lần chạy CI của dự án. Bản cài đã ký sẽ có sau.

## 1. Tải bản cài

1. Mở workflow **desktop-build** trong GitHub Actions của dự án và chọn một lần chạy màu xanh trên commit bạn cần.
2. Tải tệp **ludy-desktop-unsigned-win32-x64** (giữ 7 ngày) rồi giải nén. Bên trong có `LudyDesktop-Setup.exe`, một tệp `.nupkg` và `RELEASES`.

## 2. Chạy và vượt qua cảnh báo của Windows

1. Bấm đúp `LudyDesktop-Setup.exe`.
2. Windows SmartScreen hiện "Windows protected your PC" vì tệp chưa ký. Chọn **More info**, rồi **Run anyway**.
3. Ứng dụng cài riêng cho tài khoản của bạn (không cần quyền quản trị) rồi tự chạy. Tìm chấm tròn của nó ở vùng thông báo (Win+B, rồi phím mũi tên, rồi Enter).

## 3. Trỏ nó về Ludy của bạn

Ứng dụng không có sẵn địa chỉ nào. Hãy đặt trước lần đăng nhập đầu, ở một trong hai nơi (biến môi trường được ưu tiên):

- biến môi trường của người dùng: `LUDY_URL=https://ludy.cong-ty-ban.example` (chỉ https; `http://localhost:8080` dùng được cho bộ thử trên máy), hoặc
- tệp `config.json` trong `%APPDATA%\ludy-desktop` có nội dung `{ "ludyUrl": "https://ludy.cong-ty-ban.example" }`.

Tùy chọn, để tự cập nhật: `LUDY_DESKTOP_UPDATE_URL` (hoặc `"updateUrl"` trong `config.json`), là thư mục https chứa `RELEASES` và tệp `.nupkg` của hệ thống của bạn. Không đặt thì tắt cập nhật và khay sẽ nói rõ. Khởi động lại ứng dụng sau khi đổi.

## 4. Đăng nhập và đăng xuất

- Mục **Đăng nhập** trên khay mở trình duyệt tới Ludy của bạn. Đăng nhập như thường lệ, chọn tổ chức và bấm **Cho phép**. Trình duyệt quay về ứng dụng và chấm tròn chuyển sang màu xanh lá.
- Mục **Đăng xuất** xóa phiên đăng nhập trên máy này.

Menu khay mở bằng cú nhấp, hoặc phím Enter hay phím Menu khi biểu tượng đang được chọn. Menu có **Mở Ludy** (mở Ludy trong trình duyệt), **Đăng nhập** hoặc **Đăng xuất**, **Khởi động lại để cập nhật** khi có bản mới, và **Thoát**. Rê chuột lên biểu tượng để xem trạng thái: xám là chưa đăng nhập, xanh lá là đã đăng nhập, xanh dương là có bản cập nhật, đỏ là có vấn đề (sai địa chỉ, đăng nhập bị từ chối, cập nhật lỗi).

## Mã đăng nhập nằm ở đâu

Mã đăng nhập chỉ được lưu dưới dạng dữ liệu đã mã hóa bởi Windows (DPAPI, qua `safeStorage` của Electron, gắn với tài khoản Windows của bạn) trong `%APPDATA%\ludy-desktop`. Nó không bao giờ là tệp văn bản thường và không bao giờ nằm trong nhật ký. Nếu Windows không mã hóa được thì không lưu gì cả và bạn đăng nhập lại sau khi khởi động lại. Mã này thuộc về một tổ chức và một thành viên, và ở phiên bản này không có quyền tính năng nào: nó chỉ hỏi được máy chủ "tôi là ai".

## Ngắt kết nối một thiết bị

Trong Ludy mở **Cài đặt**, **Thiết bị đã kết nối**: máy tính để bàn hiện ngay cạnh các tiện ích trình duyệt của bạn, kèm lần dùng gần nhất. Bấm **Ngắt kết nối** để thu hồi; ứng dụng tự đăng xuất ở lần kiểm tra kế tiếp (tối đa 15 phút, hoặc ở lần mở sau). Chủ sở hữu và quản trị viên có thể ngắt thiết bị của bất kỳ thành viên nào trong phần thiết bị của tổ chức.

## Cập nhật

Khi đã đặt `LUDY_DESKTOP_UPDATE_URL`, ứng dụng kiểm tra lúc mở và mỗi 6 giờ. Bản mới tải ngầm và khay hiện **Khởi động lại để cập nhật**; không có gì tự khởi động lại. Cập nhật lỗi thì phiên bản bạn đang dùng không bị đụng tới.

## Gỡ cài đặt

Settings, Apps, **Ludy Desktop**, Uninstall. Hãy ngắt kết nối thiết bị trong Ludy nữa, vì gỡ cài đặt không báo cho máy chủ.
