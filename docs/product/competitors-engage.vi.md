# So sánh Ludy Engage với Hootsuite, Publer, Buffer, Sprout Social, Meta Business Suite, HubSpot, Pancake và Intercom / Crisp: tóm tắt cho JOY

Xong (bản nháp để anh xem). Viết ngày 2026-11-06 theo yêu cầu của anh (issue #2677). Bản đầy đủ bằng tiếng Anh, có bảng chi tiết và nguồn, là bản chính: [competitors-engage.md](competitors-engage.md). Bản so sánh cả bộ Ludy với MISA, Base, HubSpot, Odoo, Pancake nằm ở [competitors.vi.md](competitors.vi.md); trang này chỉ nhìn riêng Ludy Engage.

Trang này là bản đồ thị trường, không phải kế hoạch. Nó không xây gì, không cam kết tính năng, giá hay ngày giao. Theo quy tắc của dự án, tính năng mới nhìn thấy được với khách phải trình anh trước: chưa có issue nào được mở và chưa xây gì cho các khoảng trống bên dưới cho đến khi anh đồng ý.

## Cách đọc trạng thái của Ludy

Đã đối chiếu với nhánh main ngày 2026-11-06:

- **Đã có:** mã đã nằm trên main. Chưa có nghĩa là đã thử với tài khoản thật: với Facebook Page và Zalo OA, lần thử trực tiếp đầu tiên vẫn là việc của anh.
- **Đã xây, chưa bật:** mã đã trên main và đã kiểm thử, nhưng công tắc đang tắt cho đến khi anh thử trực tiếp. Hiện chỉ có việc tạo quảng cáo Meta ở trạng thái này.
- **Đang xây:** có kế hoạch và issue xây đang mở.
- **Mới lên kế hoạch:** chỉ có trong kế hoạch hoặc ADR, chưa có issue.
- **Chưa có:** không có kế hoạch, ADR hay issue.

Ô của đối thủ ghi có, một phần hoặc không, kèm tên sản phẩm hoặc gói. "Chưa xác nhận" nghĩa là các trang công khai đã đọc không nói rõ, không có nghĩa là "không".

## Tám đối thủ là ai

- **Hootsuite:** bộ quản lý mạng xã hội của Mỹ cho đội nhóm và agency: đăng bài, hộp thư (tên Nest), báo cáo, theo dõi thảo luận (listening), AI. Gói tính cho công ty chứ không cho một chủ.
- **Publer:** công cụ hẹn giờ giá rẻ, tính theo tài khoản và theo thành viên, có gói miễn phí. Mạnh ở hẹn giờ hàng loạt, tự động và duyệt bài; chưa thấy hộp thư bình luận.
- **Buffer:** công cụ hẹn giờ tính theo kênh, có gói miễn phí, trang link-in-bio (Start Page) và hộp thư cộng đồng cho bình luận.
- **Sprout Social:** bộ công cụ cho thương hiệu: đăng bài, Smart Inbox, listening, báo cáo, AI; tính theo người dùng và là bộ đắt nhất nhóm.
- **Meta Business Suite:** công cụ của chính Meta cho Facebook và Instagram: hẹn giờ, một hộp thư cho Messenger, Instagram và bình luận, trả lời tự động, số liệu, quảng cáo. Chỉ có kênh của Meta.
- **HubSpot (Marketing Hub và Service Hub):** Marketing Hub có hẹn giờ mạng xã hội, công cụ quảng cáo, tác tử AI; Service Hub có chat trên web, chatbot, ticket, help desk và tác tử AI trả lời khách.
- **Pancake:** đối thủ Việt Nam gần nhất: một hộp thư cho tin nhắn và bình luận, tự chia việc, câu trả lời lưu sẵn, thẻ, đơn hàng ngay trong chat; cả một họ ứng dụng (POS, CRM, Botcake, Webcake, Fintab). Chưa thấy đăng bài mạng xã hội trên các trang đã đọc.
- **Intercom và Crisp:** hai hộp thư chăm sóc khách mà mô hình hội thoại của Ludy học theo (ADR-0041). Intercom tính theo người dùng, AI Fin tính theo mỗi lần giải quyết xong; Crisp tính theo không gian làm việc, rẻ hơn, có gói miễn phí. Cả hai không đăng bài mạng xã hội.

**Ludy Engage** (mã nguồn mở AGPL, chạy bằng `docker compose up`) gồm bốn nhóm: Hộp thư (chat, bình luận, email đều là hội thoại, có Mới, Đang chờ, Đã xử lý; không có ticket, không có SLA theo quyết định 2026-11-03), Khách hàng & Bán hàng, Marketing (bài đăng, lịch, quảng cáo) và Báo cáo. Đồng nghiệp AI là Dy (hộp thư, khách hàng, bán hàng) và Uy (marketing), hiện qua tên giữ chỗ của danh sách đồng nghiệp. Ludy Cloud "sắp ra mắt", chưa có.

## Giá (chỉ lấy từ trang công khai, đọc ngày 2026-11-06)

Đơn vị USD, như hãng hiển thị tại ngày đọc; thay đổi không báo trước. Không có giá nào ở đây là giá của Ludy.

- **Hootsuite:** Standard từ 99, Professional từ 199, Advanced tới 399 mỗi tháng (trả theo năm), Enterprise theo báo giá. Trang không nói rõ tính theo người dùng hay không.
- **Publer:** gói Free (3 tài khoản); Professional từ 5 và Business từ 10 mỗi tháng cho 1 tài khoản mạng xã hội và 1 người dùng, thêm tài khoản hay thành viên thì cộng thêm; trả theo năm giảm 20%.
- **Buffer:** Free (3 kênh); Essentials 5 mỗi kênh mỗi tháng; Team 10 mỗi kênh mỗi tháng.
- **Sprout Social:** theo người dùng mỗi tháng, trả theo năm: 79, 199, 299, 399 tùy gói; listening là phần mua thêm, không ghi giá.
- **Meta Business Suite:** trang đã đọc không ghi giá; tiền quảng cáo trả cho Meta.
- **HubSpot:** Marketing Hub từ 7 mỗi người dùng (Starter) lên 800 mỗi tháng (Professional, thêm phí triển khai 3.000) và 3.600 mỗi tháng (Enterprise); Service Hub 90 đến 150 mỗi người dùng ở các gói cao. AI tính bằng "credits".
- **Pancake:** gói theo số trang kết nối và số nhân viên, kỳ 3, 6 hoặc 12 tháng. Trang giá đọc hôm nay không hiện số tiền; bản so sánh cả bộ ghi gói Small "từ 550.000 đồng cho 6 tháng" (đọc ngày 2026-11-04).
- **Intercom:** 19, 85, 132 mỗi người dùng mỗi tháng; Fin 0,99 mỗi lần giải quyết xong.
- **Crisp:** Free, Mini 45, Essentials 95, Plus 295 mỗi không gian mỗi tháng.

## Bảng tóm tắt (đã rút gọn; bảng đầy đủ ở bản tiếng Anh)

| Mảng | Ludy | Ai đang mạnh |
|---|---|---|
| Đăng Facebook Page, Instagram | Đã có (bài, Story, Reel, bình luận đầu tiên) | Hootsuite, Buffer, Meta |
| Zalo OA: đăng bài và chat | Đã có | Pancake (chat, không đăng bài); các tên còn lại chưa xác nhận |
| TikTok, YouTube, Threads, LinkedIn, Google Business | Đã có (TikTok: ứng dụng chưa được TikTok duyệt chỉ đăng ở chế độ riêng tư) | Buffer phủ nhiều kênh nhất trong các trang đã đọc |
| Soạn bài theo từng kênh, AI soạn và sửa | Đã có (Uy soạn, soát chính tả, chuỗi bài) | Cả nhóm đều có AI soạn bài |
| Lịch, hàng đợi, giờ đăng đẹp | Đã có ("Giờ đẹp" tính từ bài của chính tổ chức) | Hootsuite, Publer, Sprout |
| Hẹn giờ hàng loạt, nhập CSV, RSS | Đã có | Hootsuite (tới 350 bài), Publer |
| Duyệt bài, link duyệt cho khách ngoài, báo cáo gắn nhãn khách | Đã có | Hootsuite, Publer, Buffer (gói Team) |
| Thư viện ảnh, link-in-bio | Đã có | Publer, Buffer, Hootsuite |
| Một hộp thư cho bình luận, tin nhắn, email | Đã có (Facebook, Messenger, Instagram, Zalo OA, email) | Hootsuite, Sprout, Meta, Pancake, Crisp, Intercom |
| Mới / Đang chờ / Đã xử lý, giao việc, ghi chú, câu trả lời lưu sẵn, nháp AI | Đã có | Hootsuite, Meta, Pancake, Intercom |
| Trả lời và chatbot tự động | Chưa có (người gửi mọi tin, theo thiết kế) | Meta, Pancake (Botcake), Crisp, Intercom Fin, HubSpot |
| Ticket, SLA | Chưa có, đã quyết định không làm (2026-11-03) | Intercom, Crisp, HubSpot |
| Chat trên website | Chưa có | Intercom, Crisp, HubSpot |
| Quảng cáo: đọc kết quả | Đã có (Meta; Google Ads đã nối phần đọc) | Meta, HubSpot, Sprout |
| Quảng cáo: tạo và chạy chiến dịch | Đã xây, chưa bật (công tắc `ADS_LIVE_LAUNCH` tắt đến khi anh thử trực tiếp) | Meta; các nơi khác chưa xác nhận |
| Đẩy quảng cáo (boost) một bài đã đăng | Mới lên kế hoạch (W3, chưa có issue) | Chưa xác nhận trên các trang đã đọc |
| Báo cáo, so sánh kỳ trước, báo cáo thương hiệu riêng cho khách | Đã có | Hootsuite, Sprout, Buffer, Publer |
| Listening, theo dõi đối thủ, cảm xúc tin nhắn | Chưa có | Hootsuite, Sprout, Publer (gói Business) |
| Danh sách từ cấm theo kênh | Đã có (cảnh báo hoặc chặn) | Chưa xác nhận ở đối thủ nào |
| AI chỉ đề xuất, người duyệt mới gửi | Đã có | Meta (gợi ý không tự gửi); Intercom Fin và bot của Crisp tự trả lời |
| Hạn mức chi AI theo tổ chức | Đã có | HubSpot (credits) |
| Mã nguồn mở, tự chạy trên máy mình | Đã có | Không đối thủ nào |

## Ludy Engage khác ở đâu

1. **Một hộp thư cho bình luận, chat và email, không theo mô hình ticket (đã có).** Học theo Intercom và Crisp. Trong nhóm công cụ mạng xã hội, chỉ Hootsuite và Sprout có hộp thư tầm cỡ này và cả hai thuộc gói giá cho đội nhóm. Publer chưa có, hộp thư của Meta chỉ có kênh Meta. Pancake gần nhất và hơn về số kênh và tốc độ trả lời.
2. **Đăng bài và hộp thư ở một chỗ, có cả Zalo (đã có).** Trong các trang đã đọc, chỉ Pancake nhắc Zalo và Pancake không đăng bài.
3. **Đồng nghiệp AI được kiểm tra, người duyệt mới gửi (đã có).** Bản nháp trả lời, bài đăng, quảng cáo đều là đề xuất; chữ do AI viết được đánh dấu "không đáng tin", mọi lần gọi mô hình đi qua đồng hồ ngân sách AI, và phần lõi vẫn chạy khi tắt AI. Intercom Fin và bot Crisp đi hướng ngược lại: tự trả lời. Đối thủ cũng có AI; điều các trang của họ không cho thấy là quy tắc "người duyệt mới gửi", nên đó là điều Ludy khẳng định, không phải "họ không có AI".
4. **Quảng cáo dùng tiền của chủ có hai lớp khóa (đã xây, chưa bật).** Tạo chiến dịch cần phê duyệt ghi rõ mức chi tối đa, có hạn mức và công tắc dừng khẩn; công tắc tắt cho đến khi anh thử trực tiếp. Chưa thấy đối thủ nào có điều tương tự trên các trang đã đọc.
5. **Mã nguồn mở, tự chạy được, kế toán nằm cạnh (đã có).** Miễn phí khi tự chạy, chung một danh sách liên hệ với Ludy Kế toán. Ludy Cloud chưa chạy.

Ludy còn thua ở đâu, nói thẳng: độ phủ và độ chín. Hootsuite và Sprout có listening, cảm xúc và nhiều năm làm báo cáo; hộp thư Meta có trả lời tự động; Pancake có đơn hàng và chatbot ngay cạnh chat; Buffer và Publer chỉ vài đô mỗi kênh. Ludy Cloud chưa chạy, và với Facebook Page và Zalo OA, lần thử với tài khoản thật vẫn chưa làm.

## Khoảng trống, xếp theo giá trị cho công ty một người và SME Việt Nam

Đây là gợi ý của người viết, không phải quyết định. Anh quyết; chưa xây gì và chưa mở issue nào cho đến khi anh đồng ý.

1. **Tự trả lời trong hộp thư (lời chào ngoài giờ, câu trả lời cố định, từ khóa).** Meta, Pancake, Crisp, Intercom, HubSpot có. Ludy chưa có và đang theo quy tắc người duyệt mọi tin gửi. Xếp đầu vì chủ một người không thể canh hộp thư cả ngày, nhưng cần anh quyết trước, ví dụ chỉ trả lời cố định (giờ mở cửa, giá, tồn kho), không hứa tự do.
2. **Đẩy quảng cáo một bài đã đăng (boost).** Mới lên kế hoạch (W3), chưa có issue. Đây là bước chi tiền mà phần lớn SME Việt Nam thật sự hay làm; tạo chiến dịch đã xây nên boost là lát nhỏ thêm, giữ nguyên phê duyệt và hạn mức.
3. **Nhắn hàng loạt cho người đã đồng ý (Zalo, Messenger).** Pancake (Botcake), Intercom có. Kéo khách cũ quay lại là công cụ bán hàng chính của người bán qua mạng xã hội ở Việt Nam; nền tảng và luật đồng ý (Nghị định 91/2020, luật dữ liệu cá nhân) đặt giới hạn, nên người phải duyệt mỗi lần gửi.
4. **Bình luận TikTok và YouTube trong hộp thư.** Mới lên kế hoạch (các nhà cung cấp về sau). TikTok lớn ở Việt Nam nhưng nền tảng giới hạn ứng dụng nhiều; làm sau khi Messenger, Instagram, Zalo chạy thật.
5. **Khung chat và chatbot trên website.** Intercom, Crisp, HubSpot, Pancake (Webcake). Zalo OA và Messenger đã phủ phần lớn người bán nhỏ; chỉ quan trọng khi chủ có website kéo khách.
6. **Kênh WhatsApp.** Mới lên kế hoạch ("sau"). Ít khách Việt dùng, hợp với xuất khẩu và biên mậu; cần hợp đồng API doanh nghiệp.
7. **Listening và theo dõi đối thủ.** Hootsuite, Sprout, Publer Business. Hợp với thương hiệu có ngân sách; công ty một người ít khi đọc dòng listening.
8. **Cảm xúc tin nhắn.** Sprout (gói Advanced). Giúp đội lớn lọc khách giận; nhãn ý định của Ludy đã xếp được khiếu nại cho đội nhỏ.
9. **Trung tâm trợ giúp (knowledge base).** Intercom, Crisp, HubSpot. Dành cho nơi nặng hỗ trợ; anh đã quyết không theo mô hình ticket.
10. **Ticket, SLA.** Đã quyết định không làm (2026-11-03), ghi lại cho bảng trung thực, không phải khoảng trống cần lấp.

Không nhắc lại ở đây vì đã tính ở trang bộ: email marketing (mới lên kế hoạch, epic ở Icebox), landing page, link thanh toán, cuộc gọi.

## Điều trang này không nói

- Không phải danh sách tính năng để chép. Nhiều công cụ ở đây sinh ra cho agency và thương hiệu, mà cổng phạm vi của dự án đưa phần đó vào Icebox.
- Không nêu giá, ngày hay lộ trình cho Ludy. "Mới lên kế hoạch" chỉ nghĩa là có kế hoạch ghi vậy, không phải cam kết.
- Chỉ đọc trang hãng, không đo độ sâu tính năng: "có" không nói sản phẩm làm tốt đến đâu, và tên gói là nhãn của hãng.

## Nguồn

Đọc ngày 2026-11-06. Danh sách URL đầy đủ ở mục Sources của [bản tiếng Anh](competitors-engage.md). Một số trang không mở được (vòng chuyển hướng hoặc 404) nên đã thay bằng trang trung tâm trợ giúp hoặc kết quả tìm kiếm; riêng trang giá của Sprout không mô tả đăng bài, lịch, duyệt bài và link-in-bio nên các ô đó ghi "Chưa xác nhận". Với Crisp, không thấy Zalo ở trang nào đã đọc.
