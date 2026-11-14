# Script 4: product standup with English tech terms (hop-04)

| | |
|---|---|
| Recording name | `hop-04` |
| Speakers | 4: Khoa (product lead, man), Trang (backend, woman), Bảo (frontend, man), Yến (testing, woman) |
| Voice | Mixed: Khoa speaks northern, the other three southern |
| Length | about 8 to 10 minutes read aloud |
| Covers | English tech words inside Vietnamese sentences, a bug and a hotfix, a deadline, a release date, review and deploy steps |

All people and companies here are invented. Read the format rules in the [README](README.md) before you record.

## Scene

Lịch Hẹn Xinh is a small app that lets spas and nail shops take bookings. Four people make it. They hold a short standup that runs a little long on Wednesday, the eighteenth of November, because a bug was found in the booking flow. English tech words stay in English, as the team says them.

## Script

[Khoa] Chào mọi người. Mình bắt đầu standup nhé. Hôm nay thứ tư, ngày mười tám tháng mười một. Nhắc trước là buổi này có ghi âm để lấy biên bản, mọi người ổn chứ?

[Trang] Dạ ổn anh.

[Bảo] Ổn nha anh.

[Yến] Dạ em ổn.

[Khoa] Rồi. Mỗi người nói hôm qua làm gì, hôm nay làm gì, và có blocker gì không. Trang đi trước nhé.

[Trang] Dạ. Hôm qua em làm xong cái API đặt lịch hẹn lặp lại, tức là khách đặt một lần mà lặp lại mỗi tuần. Em đã mở pull request rồi, đang chờ review. Hôm nay em tính làm tiếp phần gửi nhắc lịch qua tin nhắn. Còn blocker thì em có một cái, em cần anh Bảo xác nhận format của cái endpoint trả về danh sách lịch.

[Bảo] Dạ, để lát em coi lại rồi nhắn em Trang liền. Em tưởng mình đã thống nhất trả về mảng rồi chớ.

[Trang] Thống nhất rồi, nhưng em thêm một trường mới tên là ngày kết thúc lặp, nên em muốn báo trước kẻo màn hình bị lỗi.

[Bảo] Dạ, vậy là em phải sửa component hiển thị lịch. Em sửa trong sáng nay được.

[Khoa] Được. Bảo nói phần của em đi.

[Bảo] Dạ hôm qua em làm xong màn hình chọn giờ, có kiểm tra giờ trống theo từng nhân viên. Em đang chờ review pull request của anh Khoa. Hôm nay em sẽ sửa cái component lịch như nói ở trên, rồi làm tiếp màn hình xác nhận đặt lịch. Có một việc nữa là chế độ nền tối, dark mode, em chưa làm được, em xin dời qua sprint sau được hông anh?

[Khoa] Dark mode thì dời được. Anh đồng ý, dark mode chuyển sang backlog, không làm trong sprint này. Mình tập trung cho release thứ hai. Yến nói đi.

[Yến] Dạ em có một tin xấu nè. Hôm qua em test trên môi trường staging và phát hiện một bug khá nghiêm trọng. Khi khách đặt lịch vào đúng khung giờ cuối cùng trong ngày, ví dụ tám giờ tối, thì hệ thống bị timeout và không báo gì hết. Khách tưởng đã đặt được nhưng thực ra không có lịch nào được lưu.

[Khoa] Trời, bug này nghiêm trọng thật. Nó có xảy ra ở môi trường production không?

[Yến] Dạ em kiểm tra log của production sáng nay. Bữa giờ có mười hai lượt lỗi giống vậy trong bảy ngày qua. Mười hai khách đã tưởng đặt được mà không được. Em nghĩ có thể là chủ tiệm bị mất khách.

[Khoa] Chết thật. Trang, em nghĩ nguyên nhân là gì?

[Trang] Dạ em đoán là do cái hàm kiểm tra giờ trống. Nó so sánh giờ theo múi giờ sai khi sang ngày kế tiếp, và nó chạy một cái truy vấn rất nặng vào database nên bị timeout. Để em xem log kỹ thì chắc hơn. Em cần khoảng hai tiếng.

[Khoa] Được, em xem đi. Đây là việc ưu tiên cao nhất hôm nay, mọi thứ khác tạm hoãn. Mình sẽ làm hotfix. Yến, em viết lại các bước tái hiện bug thành một ticket cho Trang trước mười giờ nhé.

[Yến] Dạ, em viết ticket xong trước mười giờ sáng nay, kèm ảnh chụp log.

[Khoa] Trang, khi sửa xong thì mở pull request riêng, đánh dấu là hotfix. Anh sẽ review ngay, không chờ. Bảo cũng giúp anh review vì cái này đụng cả phần giao diện thông báo lỗi.

[Bảo] Dạ, em review liền. Mà còn một vấn đề nữa anh ơi, khi bị timeout thì màn hình đang hiện cái vòng quay vô tận, khách hổng biết gì hết. Em sẽ thêm thông báo lỗi rõ ràng, kiểu "Không đặt được lịch, vui lòng thử lại", và nút thử lại.

[Khoa] Hay đấy, Bảo làm luôn. Giờ mình bàn về lịch deploy. Anh nghĩ thế này: hotfix sửa xong thì deploy lên staging trước, Yến test lại, rồi mới deploy lên production. Mục tiêu là deploy hotfix lên production chậm nhất vào chiều thứ năm, ngày mười chín tháng mười một, trước năm giờ chiều.

[Yến] Dạ, vậy em cần bản trên staging chậm nhất trưa mai, mười hai giờ, để em có buổi chiều test. Em test cả trường hợp khung giờ cuối ngày lẫn trường hợp qua nửa đêm, vì em nghi là nó cũng lỗi.

[Trang] Dạ, em hứa có bản sửa trên staging trước trưa mai. Nếu sáng nay em tìm ra nguyên nhân sớm thì em xong ngay hôm nay.

[Khoa] Được. Anh có một yêu cầu: trước khi deploy production thì phải có kế hoạch rollback. Nếu hotfix gây lỗi mới thì quay lại bản cũ trong vòng mười phút. Trang viết kế hoạch rollback ngắn vài dòng, đưa vào ticket.

[Trang] Dạ được anh. Em ghi vào ticket luôn.

[Khoa] Còn một chuyện nữa là khách bị ảnh hưởng. Mười hai khách đó, chủ tiệm có biết không?

[Yến] Dạ em chưa báo. Em nghĩ mình cần gửi thông báo cho các chủ tiệm bị ảnh hưởng. Em có danh sách rồi, gồm bảy tiệm.

[Khoa] Anh sẽ liên hệ bảy chủ tiệm. Anh sẽ gọi điện và gửi một tin nhắn xin lỗi ngắn gọn, nói rõ lỗi đã được sửa. Anh làm trong ngày mai, thứ năm, sau khi hotfix lên production. Yến gửi anh danh sách bảy tiệm và giờ bị lỗi, trước mười một giờ hôm nay.

[Yến] Dạ em gửi anh trước mười một giờ nay.

[Khoa] Giờ nói về release. Trang, pull request đặt lịch lặp lại mình review và merge khi nào?

[Trang] Dạ em đang chờ review mà. Anh Bảo hay anh Khoa review dùm em được hông? Em muốn merge trước thứ sáu, ngày hai mươi.

[Bảo] Dạ em sẽ review pull request đó vào chiều nay, sau khi review cái hotfix. Chắc có vài góp ý nhỏ thôi.

[Khoa] Rồi. Bảo review pull request đặt lịch lặp lại trong chiều nay. Trang merge trước thứ sáu, ngày hai mươi. Còn deadline của release lần này thì mình giữ là thứ hai, ngày hai mươi ba tháng mười một, hả? Yến, em thấy kịp không?

[Yến] Dạ em thấy hơi căng. Em cần ít nhất hai ngày test toàn bộ trước khi release, tức là bản cuối phải xong trước thứ sáu. Mà hotfix thì cũng chiếm của em một buổi chiều. Nếu hotfix chạy suôn sẻ thì kịp, còn nếu hotfix gặp rắc rối thì phải dời.

[Khoa] Anh hiểu. Vậy mình quyết thế này: deadline release giữ nguyên là thứ hai, ngày hai mươi ba. Nhưng sẽ chốt code, code freeze, vào thứ năm tuần sau thì sao? Không, ý anh là thứ sáu, ngày hai mươi, lúc năm giờ chiều. Sau đó không thêm tính năng mới, chỉ sửa lỗi. Nếu thứ sáu chưa xong thì dời release sang thứ tư, ngày hai mươi lăm, anh sẽ quyết vào sáng thứ sáu.

[Trang] Dạ, vậy là code freeze thứ sáu năm giờ chiều, ngày hai mươi.

[Bảo] Dạ rõ anh.

[Khoa] Có thêm một việc nữa là thông báo đẩy, push notification. Trang nói phần nhắc lịch qua tin nhắn, mình có cần phải gửi push notification trên điện thoại cho chủ tiệm khi có lịch mới không?

[Trang] Dạ cái đó làm được nhưng em nghĩ nên để sprint sau. Em cần tích hợp dịch vụ của bên thứ ba, mà hôm qua em thử gọi thì cái API của họ đang bị chậm, nhiều lần timeout.

[Khoa] Vậy push notification dời qua sprint sau. Nhưng em ghi lại các lỗi của bên đó, để sau này mình biết đường cân nhắc có nên dùng bên đó không.

[Trang] Dạ, em ghi lại.

[Yến] Anh Khoa, cho em hỏi một chút. Em muốn thêm test tự động cho luồng đặt lịch, để lần sau không bị bug kiểu này nữa. Em có thể làm trong sprint này không?

[Khoa] Anh đồng ý. Yến viết test tự động cho các trường hợp biên của luồng đặt lịch, tức là khung giờ cuối ngày và qua nửa đêm. Làm xong sau khi hotfix lên production, cho anh xem kết quả vào thứ hai, ngày hai mươi ba.

[Yến] Dạ, em làm.

[Khoa] Rồi, anh tóm tắt. Một, ưu tiên hôm nay là hotfix bug timeout, Yến tạo ticket trước mười giờ, Trang sửa và có bản staging trước trưa mai, deploy production chậm nhất năm giờ chiều mai thứ năm ngày mười chín, có kế hoạch rollback. Hai, Bảo review hotfix, thêm thông báo lỗi và nút thử lại, review pull request đặt lịch lặp lại chiều nay, và sửa component lịch sáng nay. Ba, Yến gửi anh danh sách bảy tiệm trước mười một giờ, anh liên hệ các chủ tiệm ngày mai. Bốn, Trang merge đặt lịch lặp lại trước thứ sáu ngày hai mươi. Năm, code freeze thứ sáu ngày hai mươi lúc năm giờ chiều, release thứ hai ngày hai mươi ba. Sáu, dark mode và push notification dời sang sprint sau. Bảy, Yến viết test tự động cho các trường hợp biên, cho anh xem thứ hai ngày hai mươi ba. Mọi người còn gì không?

[Trang] Dạ em hết.

[Bảo] Em cũng hết anh.

[Yến] Dạ em cũng vậy.

[Khoa] Vậy mọi người bắt đầu làm nhé. Cảm ơn cả nhóm.

## Decisions and action items (not read aloud)

For the summary eval. The meeting is on Wednesday, the eighteenth of November.

Decisions:
- The timeout bug at the last booking slot of the day is the top priority; everything else waits. It is fixed as a hotfix, tested on staging, then deployed to production.
- The hotfix is deployed to production by five in the afternoon on Thursday, the nineteenth of November, with a rollback plan that returns to the old version within ten minutes.
- Dark mode and push notifications move to the next sprint (the backlog).
- Code freeze: Friday, the twentieth of November, at five in the afternoon. Release: Monday, the twenty-third. If it is not ready on Friday the release moves to Wednesday, the twenty-fifth (Khoa decides on Friday morning).
- The twelve failed bookings were in seven shops; their owners are told about the bug and the fix.

| Action | Who | Due |
|---|---|---|
| Write the ticket with the steps to reproduce the bug and a screenshot of the log | Yến | Wednesday, 18 November, before ten in the morning |
| Send the list of the seven affected shops and the times of the errors | Yến | Wednesday, 18 November, before eleven |
| Find the cause and fix the bug, with a rollback plan in the ticket; put the fix on staging | Trang | Thursday, 19 November, before noon |
| Deploy the hotfix to production | Trang (with Yến's tests on staging) | Thursday, 19 November, before five in the afternoon |
| Review the hotfix pull request; add a clear error message and a retry button | Bảo | Wednesday, 18 November (the review), no later date said for the message |
| Fix the calendar component for the new end-date field | Bảo | Wednesday, 18 November, in the morning |
| Review the pull request for repeating bookings | Bảo | Wednesday, 18 November, in the afternoon |
| Merge the pull request for repeating bookings | Trang | before Friday, 20 November |
| Call the seven shop owners and send a short apology | Khoa | Thursday, 19 November, after the hotfix is live |
| Decide whether the release moves to 25 November | Khoa | Friday, 20 November, in the morning |
| Write automatic tests for the edge cases of the booking flow and show the result | Yến | Monday, 23 November |

Numbers that appear in the script: twelve failed bookings in seven days, seven shops, eight in the evening as an example slot, two hours to study the log, ten minutes to roll back, two days of full testing.
