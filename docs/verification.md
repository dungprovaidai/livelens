# Kiểm tra LiveLens — 26/11/2026

## Môi trường

- Node.js 24.22.3.
- tiktok-live-connector 2.5.0, khóa phiên bản trong package-lock.json.
- Kiểm thử HTTP chạy với server Node thực và SQLite thực. Chỉ ranh giới kết nối TikTok được thay bằng connector kiểm thử có thể điều khiển.

## Đã thực hiện

- `npm test`: **29/29 kiểm thử đạt**, không bỏ qua kiểm thử nào.
- `npm run typecheck`: đạt.
- `npm run build`: đạt; tạo gói mã nguồn và frontend production.
- Phân tích cú pháp `compose.yaml`: có ba dịch vụ app/db/proxy và các volume tương ứng.
- `node --check scripts/dev.mjs`: đạt.

Các kiểm thử backend bao gồm URL TikTok, ID dài, quà combo, sự kiện trùng, thiếu metadata quà, quà có type bằng 0, giới hạn một phiên, dừng khi đang kết nối, hủy retry, HTTP auth/CORS, lưu lịch sử sau restart, SSE replay, CSV an toàn công thức và chế độ demo API. Một kiểm thử dùng chính connector đã khóa phiên bản với HTTP upgrade cục bộ đang treo, xác nhận AbortSignal thực sự hủy bắt tay WebSocket.

Kiểm thử frontend xác minh token chỉ dùng với đúng origin đã lưu, bỏ qua token cũ chưa gắn origin, không gửi Authorization tới health công khai và giữ thời gian kết thúc demo ổn định qua nhiều lần tải lại. Hai kiểm thử Vite xác nhận dev mặc định chỉ bind loopback và bản preview frontend không proxy API cục bộ không có token.

## Kiểm tra trong trình duyệt

- Quan sát giao diện desktop, tăng cỡ chữ nội dung comment lên 16 px và kiểm tra lại khả năng đọc.
- Chạy/dừng demo; xác nhận comment và quà cập nhật, dừng cuộn không dừng nhận sự kiện.
- Tìm theo tài khoản, xem lịch sử phiên và tải CSV.
- Lưu từ khóa thông báo, mở/đóng cài đặt kết nối, từ chối URL máy chủ không hợp lệ.
- Điền token thử không có giá trị thật rồi thay địa chỉ máy chủ; ô token được xóa ngay.
- Chuyển sang LIVE thật không trộn dữ liệu mẫu; URL TikTok không hợp lệ bị từ chối và thiếu backend được báo rõ.
- Nút tải mã nguồn khởi tạo tải file ZIP thành công.

Rà soát mã nguồn đã xử lý các lỗi tìm thấy về quà type 0, hủy bắt tay WebSocket, bảo vệ API dev, token giữa các origin, thời gian demo và đầu vào build Docker. Không còn lỗi Critical/Important trong phạm vi đã rà soát.

## Giới hạn kiểm tra bên ngoài

- Chưa kiểm tra việc nhận comment/quà từ một phòng TikTok đang LIVE thực tế. Không có link LIVE mục tiêu của người dùng; nguồn TikTok và dịch vụ ký có điều kiện truy cập riêng.
- Chưa chạy Docker Compose hoặc kết nối PostgreSQL thực tế trong môi trường này vì không có Docker/database service. Cấu hình được cung cấp để chạy trên máy/server của người dùng.
- Chưa thử thiết bị điện thoại thực tế và chưa cấp quyền thông báo hệ điều hành. Thông báo nền khi đóng web chưa được triển khai.
- Bản triển khai Sites phục vụ frontend. Phần nhận LIVE liên tục cần backend Node đi kèm chạy trên một máy/server còn hoạt động.

## Kiểm tra sau khi cập nhật giao diện đọc bình luận trên Windows

- Môi trường lần này: Node.js 24.20.0 và Chrome trên Windows.
- `npm run build`: đạt, gồm kiểm tra TypeScript và tạo frontend production.
- `python tests/reader-ui.py http://localhost:3002`: đạt. Kiểm tra bộ lọc mặc định chỉ hiện bình luận, tìm tiếng Việt không dấu, lưu cỡ chữ và giới hạn 18–30 px, tự dừng cuộn khi xem tin cũ, tiếp tục nhận tin và trở về mới nhất, bật/tắt toàn màn hình, xuống dòng bình luận dài, hiển thị HTML dưới dạng chữ, lịch sử và tải CSV. Không ghi nhận lỗi JavaScript trong trình duyệt.
- Kiểm tra ở các viewport 1440×900, 1280×800, 1024×768, 768×1024, 390×844 và 320×740; không bị tràn ngang. Đã xem ảnh chụp giao diện desktop và viewport điện thoại.
- Lần kiểm tra giao diện đầu tiên có lỗi `EBUSY` trong test dọn SQLite trên Windows. Lỗi này đã được sửa trong đợt hoàn thiện bên dưới.
- Chưa thử nhận bình luận từ phòng TikTok LIVE thực tế hoặc trình duyệt trên điện thoại thực.

## Hoàn thiện chức năng sau rà soát

- `npm test`: **36/36 đạt**, tiến trình kết thúc bình thường trên Windows, không dùng `--test-force-exit`. Cleanup test đóng database trước khi xóa thư mục tạm.
- Kiểm thử lỗi ghi comment và lỗi ghi trạng thái: nguồn được ngắt, không ghi tiếp các sự kiện đang chờ, API phiên trả trạng thái lỗi, health trả 503 và từ chối bắt đầu phiên mới cho tới khi sửa lưu trữ và khởi động lại. Trường hợp database không ghi được cả trạng thái lỗi vẫn được phản ánh qua bộ nhớ của tiến trình.
- Kiểm thử HTTP/SQLite với 650 comment: phân trang về đúng tin đầu tiên, không trùng sự kiện, tìm toàn phiên bằng tiếng Việt không dấu và ký tự `%_` đúng nghĩa; từ chối cursor/bộ lọc không hợp lệ.
- `tests/functional-ui.py`: xác nhận phát hiện phiên từ tab khác, khôi phục LIVE sau tải lại trang, bật âm thanh theo thao tác người dùng và nhận âm báo quà, tải tin cũ giữ vị trí đọc, giữ comment khi tải trang cũ lỗi, tìm lại tin đầu phiên trong cả LIVE lẫn lịch sử, khóa ô nhập/nút lưu trong lúc kiểm tra kết nối và hiện cảnh báo lưu trữ.
- `tests/reader-ui.py`: các kiểm tra đọc comment, demo, toàn màn hình, cỡ chữ, mobile, lịch sử và CSV vẫn đạt.
- Kết nối TikTok trong các kiểm thử là nguồn giả; không coi đây là bằng chứng đã nhận dữ liệu từ phòng LIVE thật. Thông báo khi đóng trang và Docker/PostgreSQL thực tế chưa được kiểm tra trong đợt này.

## Thống kê người xem và kiểm tra âm báo

- `npm test`: **41/41 đạt**. Thêm kiểm tra raw v3 viewer/like counts, phân biệt 0 với chưa có dữ liệu, bỏ qua tổng lượt xem tích lũy khi lấy số đang xem, join/follow/share, ID dài, sự kiện trùng và quà combo không làm tăng trùng thống kê.
- Kiểm tra danh sách 205 tài khoản, phân trang không trùng, lọc tên chứa dấu gạch dưới, lọc lịch sử đúng ID, quyền truy cập API/CSV và xuất đầy đủ với tên tài khoản trông giống công thức bảng tính.
- Kiểm tra nâng cấp database cũ: tạo lại các bảng tổng hợp từ lịch sử, mở lại hai lần không đếm trùng và không thay đổi sự kiện gốc. Demo giữ thống kê sau 350 sự kiện trong khi luồng chỉ giữ 300 sự kiện gần nhất.
- `tests/audience-ui.py`: xác nhận bảng demo/LIVE, số liệu tự cập nhật, biểu đồ, tìm tên không dấu qua toàn bộ danh sách, chuyển trang, xem 350 sự kiện của một tài khoản, CSV tổng hợp và bố cục 320/390/768 px không tràn ngang ngoài vùng bảng.
- Kiểm tra âm thanh bằng AudioContext thật của Chrome: nút Nghe thử tạo tín hiệu có biên độ đo được; nút Bật báo mọi bình luận lưu đúng tùy chọn, và comment mới trong demo tạo tiếng báo tự động. Đây là kiểm tra tín hiệu trong trình duyệt, không xác nhận âm lượng loa, thiết bị đầu ra hoặc tab của người dùng đang bật tiếng.
- Hai bộ kiểm tra `reader-ui.py` và `functional-ui.py` vẫn đạt. Chưa chạy PostgreSQL/Docker thực tế hoặc xác minh tất cả sự kiện người xem/like/follow/share từ một phòng TikTok LIVE thật.

## Âm báo bình luận, thông báo khi chuyển tab và cập nhật backend

- Người dùng xác nhận đã nghe được âm thanh. Trong một tab kiểm tra riêng dùng phòng LIVE thực, bản cũ nhận một chat mới nhưng không khởi tạo tiếng báo: AudioContext đang chạy, thông báo bình luận mặc định vẫn tắt và nút mở khóa âm thanh đã biến mất. Đây là bằng chứng cho lỗi trạng thái/nút bật; không phải đọc cài đặt trong tab Cốc Cốc của người dùng.
- Luồng bình luận hiện rõ khi âm báo đang tắt, báo bình luận đang tắt, cần mở âm thanh hoặc đang lọc từ khóa. Nút **Bật báo mọi bình luận** lưu cả lựa chọn âm thanh và bình luận, xóa từ khóa và phát thử. Nếu phát một sự kiện thất bại, app hiện lại nút mở âm thanh.
- **Bật thông báo bình luận** xin quyền sau thao tác của người dùng, bật mọi bình luận và giữ lựa chọn âm thanh. Thông báo hệ điều hành có tên người bình luận và tối đa 300 ký tự nội dung khi trang bị ẩn hoặc mất focus. Bấm thông báo để quay lại màn hình đọc; tab đang được đọc không bật popup trùng. Từ chối quyền có hướng dẫn ngay trong giao diện.
- `npm test`: **42/42 đạt**. Bao gồm trạng thái âm thanh bị tạm ngưng, bộ lọc bình luận, quyền thông báo, tên/nội dung, điều kiện trang nền, nhãn demo, tag sự kiện và xử lý bấm thông báo/lỗi API trình duyệt. `npm run build` đạt.
- `tests/functional-ui.py` đạt với chat LIVE qua SSE giả, bật từ tùy chọn đã lưu đang tắt, không phát lại âm từ snapshot khi nối lại và phục hồi sau AudioContext bị tạm ngưng. `reader-ui.py` và `audience-ui.py` vẫn đạt, gồm tín hiệu Web Audio thật của Chrome.
- `tests/notifications-ui.py` đạt với Notification thật của Chrome và API LIVE giả: bật/tắt, tên và nội dung, tránh popup khi đọc trang, không phát lại lịch sử, từ chối quyền và bố cục điện thoại. Headless Chrome dùng CDP để tắt focus giả lập khi kiểm tra tab nền; đây chưa phải kiểm tra banner Windows trong Cốc Cốc của người dùng.
- Lỗi **Không tìm thấy đường dẫn** ở Người xem được xác nhận là HTTP 404 từ tiến trình backend cũ. Đã tạo backup SQLite nhất quán, dừng nhận sự kiện qua API, thay tiến trình và nối lại cùng tài khoản/phòng LIVE. So sánh toàn bộ seq/session/payload của **462 sự kiện** trước cập nhật: không thay đổi. Các phiên cũ vẫn nằm trong lịch sử; phiên theo dõi tiếp theo có ID mới.
- API Người xem sau cập nhật trả HTTP 200. Phòng thật gửi mẫu **174 người đang xem** và 6 chat mới trong những giây đầu sau khi nối lại. Việc đổi tiến trình có khoảng ngắt nguồn ngắn; không có cam kết lấy lại dữ liệu TikTok trong khoảng đó.
- Đã nhận comment thật qua SSE của phiên nối lại và đối chiếu Notification thật của Chrome khi trang mất focus: sự kiện chat seq **1125** tạo đúng một thông báo, tên người gửi và nội dung khớp dữ liệu nguồn. Trình duyệt kiểm tra dùng profile cô lập được cấp quyền bằng automation; chưa xác nhận banner hiển thị trong Cốc Cốc/cài đặt thông báo Windows của người dùng. Các lượt chờ trước đó hết thời gian và không được tính là thành công.
- Kiểm tra trực tiếp giao diện LIVE: số đang xem được cập nhật, mở được trang 50 tài khoản và không có lỗi API trong hộp Người xem. Sửa độ ưu tiên CSS của chiều rộng hộp và dành tối thiểu 200 px cho cột tài khoản để tên không bị ép còn một ký tự.
