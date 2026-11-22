# Tingee bank feed: help for owners and admins / Nguồn giao dịch Tingee: hướng dẫn cho chủ sở hữu và quản trị viên

Connect your own Tingee account so bank transactions reach Ludy by themselves, instead of uploading a statement every month. Vietnamese first, English second. For the person who sets it up (an owner or an admin); members and viewers only see the result.

Kết nối tài khoản Tingee của chính bạn để giao dịch ngân hàng tự về Ludy, không phải tải sao kê lên mỗi tháng. Tiếng Việt trước, tiếng Anh sau. Dành cho người thiết lập (chủ sở hữu hoặc quản trị viên); thành viên và người chỉ xem chỉ thấy kết quả.

**Trạng thái / Status:** the feed is written and tested against Tingee's public documentation. It is offered to a real company only after the UAT check ([runbook](../runbooks/tingee-uat-check.md)) has settled a few facts with Tingee's test environment. Until then, ask your Ludy administrator whether it is switched on for you. / Nguồn này đã viết và kiểm thử theo tài liệu công khai của Tingee. Chỉ khi chạy kiểm tra UAT xong ([quy trình](../runbooks/tingee-uat-check.md)) thì mới mở cho công ty thật. Trước đó, hãy hỏi quản trị viên Ludy xem đã bật cho bạn chưa.

---

## Tiếng Việt

### Ludy làm gì và không làm gì

- **Chỉ đọc.** Ludy đọc danh sách tài khoản ngân hàng và giao dịch của từng tài khoản. Ludy **không bao giờ** chuyển tiền, không gọi Chi hộ, Direct debit hay Hoàn tiền.
- **Người vẫn là người duyệt.** Giao dịch về từ Tingee vào màn hình ngân hàng như các dòng nhập từ sao kê; mọi phiếu vẫn chờ một người duyệt như thường lệ.
- **Webhook chỉ là tín hiệu.** Khi có giao dịch mới, Tingee báo cho Ludy qua một địa chỉ riêng. Thông báo đó không tự ghi giao dịch nào: nó chỉ làm Ludy đi đọc lại tài khoản ngay. Mỗi ngày Ludy cũng tự đọc một lần dù không có thông báo.

### Bạn cần chuẩn bị

1. Một tài khoản Tingee của bạn, đã liên kết tài khoản ngân hàng (việc liên kết làm ở Tingee, không làm ở Ludy).
2. Vai trò chủ sở hữu hoặc quản trị viên trong Ludy.

### Bước 1. Trong cổng Tingee: tạo thông tin xác thực cho Ludy

1. Đăng nhập cổng Tingee của bạn và tạo một thông tin xác thực API cho Ludy.
2. **Chỉ cấp nhóm quyền Tài khoản và Giao dịch** (chỉ đọc).
3. **Không cấp** Chi hộ, Direct debit hay Hoàn tiền. Ludy không bao giờ cần; thông tin xác thực thiếu các quyền đó thì không thể chuyển tiền, kể cả khi bị lộ.
4. Giữ lại hai giá trị cổng cho bạn: **Client ID** và **Secret Token**.

### Bước 2. Trong Ludy: kết nối

1. Mở **Cài đặt**, thẻ **Nguồn giao dịch ngân hàng**, mục **Kết nối Tingee**.
2. Dán **Client ID** và **Secret Token**. Có thể đặt tên cho kết nối (không bắt buộc).
3. Bấm **Kết nối Tingee**.

Secret Token được lưu mã hóa và **không hiện lại lần nào nữa**, kể cả với bạn. Nếu mất, hãy tạo thông tin xác thực mới ở Tingee rồi kết nối lại.

Sau vài phút, các tài khoản ngân hàng Tingee cung cấp sẽ hiện ở thẻ này (khi chưa có, thẻ ghi "Đang chờ lần đồng bộ đầu tiên").

### Bước 3. Gắn từng tài khoản vào sổ

1. Với mỗi tài khoản hiện ra, chọn **Tài khoản ngân hàng trong sổ** (tài khoản 112 nhận các giao dịch này), và **Pháp nhân** nếu công ty có nhiều pháp nhân.
2. Bấm **Gắn**. Từ lúc này các giao dịch của tài khoản đó đi vào màn hình ngân hàng.
3. **Ngày bắt đầu (không bắt buộc):** nếu bạn đã nhập sao kê cho tài khoản này, điền "Nguồn tự động lấy giao dịch từ ngày ...". Từ ngày đó trở đi, sao kê nhập cho tài khoản này sẽ bỏ qua các dòng từ ngày đó, và nguồn tự động bỏ qua các dòng trước ngày đó, để không ghi một giao dịch hai lần. Chọn ngày là ngày đầu tiên chưa có trong sao kê.

Muốn ngừng, bấm **Gỡ liên kết** ở tài khoản đó.

### Bước 4. Webhook: để giao dịch về ngay

Không làm bước này cũng được: Ludy vẫn đọc mỗi ngày một lần. Làm bước này khi bạn muốn giao dịch về trong vài phút.

1. Ở thẻ kết nối, mục **Webhook**, bấm **Tạo địa chỉ**.
2. Bấm **Sao chép địa chỉ**. **Địa chỉ chỉ hiện một lần.** Sau khi đóng, chỉ có thể tạo địa chỉ mới.
3. Trong cổng Tingee, dán địa chỉ đó làm webhook của tài khoản. Khi bạn lưu, Tingee kiểm tra địa chỉ; Tingee có thể yêu cầu bạn xác minh tên miền bằng một bản ghi DNS TXT, làm theo hướng dẫn ngay trong cổng. (Tên bản ghi và cách Tingee kiểm tra sẽ được xác nhận khi chạy UAT; xem [quy trình](../runbooks/tingee-uat-check.md).)
4. Quay lại Ludy và bấm **Tôi đã dán xong, ẩn địa chỉ**.

Mục Webhook ghi: địa chỉ tạo lúc nào, thông báo gần nhất từ Tingee, số thông báo bị từ chối trong giờ này.

**Địa chỉ là bí mật.** Ai có địa chỉ có thể gửi thông báo giả. Thông báo giả không ghi được giao dịch nào, nhưng 10 thông báo bị từ chối trong một giờ làm địa chỉ ngừng nhận (mục Webhook sẽ báo "đã ngừng nhận thông báo"). Nếu địa chỉ bị lộ, hoặc đã ngừng, bấm **Đổi địa chỉ mới**.

**Đổi địa chỉ làm địa chỉ cũ ngừng hoạt động ngay.** Tingee vẫn gửi đến địa chỉ cũ cho đến khi bạn dán địa chỉ mới vào cổng; trong lúc đó Ludy vẫn đọc mỗi ngày một lần. Vì vậy Ludy hỏi lại một lần ("Đúng, đổi địa chỉ ngay") trước khi đổi.

### Khi có điều bất thường

- **Kết nối báo lỗi hoặc hết hạn:** kiểm tra Client ID và Secret Token còn dùng được ở Tingee, nếu cần tạo mới rồi ngắt kết nối và kết nối lại.
- **Giao dịch không về dù đã gắn tài khoản:** xem "Đồng bộ lần cuối" ở thẻ; Ludy đọc ít nhất mỗi ngày một lần. Webhook chậm hoặc ngừng không làm mất giao dịch.
- **Thấy một giao dịch hai lần (một từ Tingee, một từ sao kê):** đặt ngày bắt đầu ở Bước 3, rồi báo quản trị viên Ludy.
- **Muốn thôi hẳn:** ở Tingee, vô hiệu (xóa) thông tin xác thực đã tạo cho Ludy; từ lúc đó Ludy không đọc được nữa và thẻ sẽ báo kết nối có sự cố. Việc gỡ kết nối khỏi Ludy hiện chưa có nút ở thẻ này; hãy báo quản trị viên Ludy.

---

## English

### What Ludy does and does not do

- **Read only.** Ludy reads the list of bank accounts and the transactions of each. It **never** moves money and never calls Chi hộ, Direct debit or Hoàn tiền.
- **A person still approves.** Transactions from Tingee reach the bank screen like statement lines, and every voucher still waits for a person to approve it.
- **The webhook is only a hint.** When a transaction arrives, Tingee tells Ludy through an address of its own. That message stores no transaction: it only makes Ludy read the account again at once. Ludy also reads once a day with no message.

### Before you start

A Tingee account of your own with the bank account linked in Tingee, and the owner or admin role in Ludy.

### Step 1. In the Tingee portal

Create an API credential for Ludy with **only the Accounts and Transactions groups** (read only), and **none** of Chi hộ, Direct debit or Hoàn tiền. Keep the **Client ID** and the **Secret Token**.

### Step 2. In Ludy

**Settings**, **Bank feeds**, **Kết nối Tingee**: paste both values and connect. The Secret Token is stored encrypted and is never shown again. After a few minutes the accounts Tingee gives the credential are listed on the card.

### Step 3. Map each account

Choose the bank account of the books that takes the transactions (and the legal entity, if there are several), then **Gắn**. Optionally set the date the feed starts: from that date on, statement imports for the account skip their lines, and the feed skips lines before it, so no transaction is booked twice. Use the first day not yet in your statements.

### Step 4. The webhook (optional, for minutes instead of a day)

**Webhook**, **Tạo địa chỉ**, copy the address (**it is shown once**), paste it in the Tingee portal as the account's webhook, then hide it in Ludy. Tingee checks the address when you save it and may ask you to verify your domain with a DNS TXT record; follow the portal (the exact name is confirmed by the UAT check). The address is a secret: anyone who has it can send false messages. False messages store nothing, but ten refused in an hour stop the address; if it leaks or stops, use **Đổi địa chỉ mới**. Replacing it stops the old one at once, so paste the new one into the portal right away.

### If something looks wrong

A connection that errors or expires: check the credential at Tingee, create a new one, disconnect and connect again. No transactions after mapping: look at "last synced" on the card; Ludy reads at least once a day, and a slow or stopped webhook never loses a transaction. A transaction twice: set the start date in Step 3 and tell your Ludy administrator. To stop for good: disable (delete) the credential you made for Ludy in Tingee; from then on Ludy cannot read, and the card reports a problem with the connection. There is no button on this card yet to remove the connection from Ludy; tell your Ludy administrator.
