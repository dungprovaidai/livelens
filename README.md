# LiveLens

Web tiếng Việt để theo dõi comment và quà TikTok LIVE. Có giao diện React, backend Node chạy liên tục, lịch sử phiên, bộ lọc, thông báo và xuất CSV.

## Hai chế độ rõ ràng

- **Demo:** dữ liệu minh họa chạy ngay trong trình duyệt, không kết nối TikTok. Dùng để thử giao diện, bộ lọc, combo quà và thông báo.
- **LIVE thật:** frontend kết nối backend Node; backend nhận sự kiện từ `tiktok-live-connector`. Trạng thái lỗi/kết nối được hiển thị thật, không thay bằng demo.

Bản frontend trên Sites là một client/demo. Muốn nhận LIVE thật và tiếp tục theo dõi sau khi đóng tab, chạy backend dưới đây trên máy đang bật hoặc server riêng. Source backend nằm trong `server/`.

## Chạy nhanh trên máy cá nhân

Cần **Node.js 24 trở lên**.

```bash
npm ci
npm run build
npm start
```

Mở **http://localhost:3001**. Chế độ mặc định dùng SQLite ở `data/livelens.sqlite`; dữ liệu còn sau khi khởi động lại. Backend mặc định chỉ lắng nghe ở loopback.

Để phát triển giao diện:

```bash
npm run dev
```

Lệnh này mở backend ở cổng 3001 và Vite; dùng URL Vite được in trong terminal. API được proxy qua cùng origin.

## Đọc bình luận

- Màn hình chính ưu tiên bình luận; thống kê và quà nằm ở cột bên cạnh. Chọn **Tất cả** hoặc **Quà tặng** để đổi loại sự kiện.
- Chữ bình luận mặc định **22 px**. Dùng nút **− / +** để chỉnh từ 18 đến 30 px; app ghi nhớ cỡ chữ cho lần mở sau.
- Cuộn lên để đọc tin cũ sẽ tự dừng cuộn, trong khi app vẫn nhận sự kiện. Bấm **Về mới nhất** để tiếp tục theo dõi; số tin mới được tính theo bộ lọc hiện tại trong luồng đang hiển thị.
- Bấm **Toàn màn hình** để dành toàn bộ màn hình cho bình luận; nhấn **Esc** để thoát.
- Với LIVE thật, ô tìm kiếm đọc **toàn bộ phiên đã lưu**, hỗ trợ tiếng Việt không dấu và tên tài khoản. Kết quả được tải theo trang 300 sự kiện; bấm **Tải tin cũ hơn** để xem tiếp và giữ nguyên vị trí đang đọc. CSV luôn xuất toàn bộ phiên đã lưu.
- Các tab tự kiểm tra danh sách phiên mỗi 5 giây và khi quay lại tab; không cần F5 để thấy phiên được bắt đầu hoặc dừng ở nơi khác.
- Sau F5, trình duyệt cần một thao tác của bạn để phát âm báo. Bấm **Bật âm báo** hoặc tương tác với trang để bật lại mà không cần dừng phiên LIVE.

## Người xem và tương tác

- Thẻ **Người xem** ở cột bên phải hiện số đang xem do TikTok gửi, mức cao nhất từ lúc app theo dõi và số tài khoản ghi nhận được. Chưa có số liệu thì hiện **—**; số 0 chỉ hiện khi nguồn thật sự gửi 0. Nếu số liệu quá 60 giây chưa cập nhật, app đánh dấu mẫu cũ; phiên đã dừng chỉ hiện lần cập nhật cuối.
- Bấm **Xem người xem** để mở biểu đồ, bảng tài khoản, số comment, quà đã chốt, like, lượt vào phòng, follow và chia sẻ ghi nhận được. Tìm tên không dấu, lọc người từng bình luận/tặng quà, hoặc sắp xếp theo từng loại tương tác. Bảng tải 50 tài khoản mỗi trang.
- Bấm tên một người để xem các sự kiện của đúng ID đó, kể cả tin cũ ngoài khung 300 sự kiện. Dùng **Tải lại tương tác** để lấy cập nhật mới và **Tải tương tác cũ hơn** để đọc tiếp.
- **Xuất CSV người xem** tải toàn bộ tài khoản của phiên, độc lập với trang và bộ lọc đang xem. Thống kê được lưu cùng sự kiện; phiên cũ được tổng hợp lại khi nâng cấp, giữ nguyên lịch sử gốc.
- TikTok có thể không gửi danh tính của người chỉ xem im lặng hoặc mọi sự kiện like/lượt vào. Danh sách là các tài khoản app đã ghi nhận, không xác nhận ai còn đang ở trong phòng. Tổng like từ nguồn và số like của từng người là hai nguồn đếm riêng.
- Demo có số liệu mô phỏng riêng. Thống kê từng người của demo được giữ khi luồng vượt 300 sự kiện, nhưng chi tiết sự kiện demo chỉ giữ các tin gần đây.

## Âm báo

Trong **Thông báo**, bấm **Nghe thử** để kiểm tra tiếng báo hai nhịp. Nút này phát thử ngay cả khi âm báo tự động đang tắt. Bấm **Bật báo mọi bình luận** để bật âm thanh, bật thông báo bình luận và xóa bộ lọc từ khóa trong một thao tác.

Bật **Âm thanh** riêng chỉ phát tiếng cho các loại thông báo đang bật. Nếu chỉ bật **Quà tặng**, comment không phát tiếng. App hiển thị rõ loại sự kiện đang được báo. Nếu nút Nghe thử báo đã phát mà vẫn không nghe, kiểm tra tab có bị tắt tiếng, âm lượng và thiết bị đầu ra của Windows. Thông báo trên màn hình cần quyền riêng của trình duyệt; âm thanh không yêu cầu bật thông báo màn hình.

Ngay trong **Luồng bình luận**, bấm **Bật thông báo bình luận** rồi chọn **Cho phép** khi trình duyệt hỏi. Nút này bật thông báo cho mọi bình luận và xóa bộ lọc từ khóa; giữ nguyên lựa chọn âm thanh. Khi bạn ở tab hoặc cửa sổ khác, thông báo hiện tên người bình luận và nội dung mới. Bấm vào thông báo để quay lại màn hình đọc. Khi đang xem LiveLens, app không bật thông báo màn hình trùng với nội dung đang đọc. Có thể tắt bằng **Tắt thông báo màn hình** hoặc chỉnh bộ lọc trong **Thông báo**.

Giữ tab LiveLens và trình duyệt mở. Nếu trình duyệt đã chặn quyền, mở cài đặt của trang cạnh thanh địa chỉ và cho phép **Thông báo**. Windows cần cho phép thông báo của trình duyệt và không bật chế độ Không làm phiền để hiện banner.

## Kết nối TikTok LIVE thật

1. Chạy backend, mở web và chọn **LIVE thật**.
2. Dán link đầy đủ dạng `https://www.tiktok.com/@username/live` hoặc `@username`.
3. Bấm **Theo dõi**. Tài khoản phải đang LIVE và connector phải truy cập được phòng.
4. Đọc trạng thái kết nối trên màn hình; nếu chưa LIVE hoặc nguồn từ chối, ứng dụng báo lỗi.

Link chia sẻ rút gọn cần mở trong TikTok/trình duyệt để lấy link đầy đủ của chủ phòng. Backend không tự tải URL tùy ý.

Một số kết nối có thể cần API key của dịch vụ ký Euler Stream do hạn mức hoặc quyền của nhà cung cấp. Sao chép `.env.example` thành `.env` và đặt `SIGN_API_KEY` ở server khi cần. Không đặt key vào mã frontend.

## Chạy Docker + PostgreSQL

1. Sao chép `.env.example` thành `.env`.
2. Đặt `APP_TOKEN` và `POSTGRES_PASSWORD` thành **hai chuỗi ngẫu nhiên khác nhau**. Dùng chuỗi hex để không cần escape trong URL database.
3. Chạy:

```bash
docker compose up --build -d
```

Mở **http://localhost:3001**. Trong phần cài đặt kết nối của web, nhập token `APP_TOKEN`. Compose dùng PostgreSQL với volume `postgres-data` và tự khởi động lại dịch vụ khi lỗi. Database không mở cổng ra ngoài.

Tạo một chuỗi ngẫu nhiên trên máy của bạn:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Dùng frontend được host sẵn với backend riêng

1. Triển khai backend lên server chạy liên tục.
2. Cấu hình HTTPS cho backend và đặt `APP_TOKEN`.
3. Thêm đúng origin frontend vào `ALLOWED_ORIGINS`, phân tách bằng dấu phẩy. Nếu backend cũng phục vụ giao diện, thêm cả origin đó, ví dụ `https://api.ten-mien-cua-ban.com`.
4. Trong **Cài đặt kết nối** trên web, điền URL backend và token. Token chỉ lưu trong phiên trình duyệt.

Nếu dùng Caddy đi kèm: trỏ DNS tên miền đến server, đặt `APP_DOMAIN=api.ten-mien-cua-ban.com`, mở cổng 80/443 rồi chạy:

```bash
docker compose --profile https up --build -d
```

Khi mở từ một frontend HTTPS, backend từ xa cũng cần HTTPS. Bản backend phục vụ luôn frontend nên có thể dùng chung một tên miền; vẫn khai báo origin của tên miền đó trong `ALLOWED_ORIGINS`.

## Quy tắc dữ liệu

- Một phiên LIVE đang hoạt động tại một thời điểm.
- Comment được hiển thị dưới dạng văn bản; nội dung không được thực thi như HTML.
- Quà combo được cập nhật theo số tích lũy và chỉ cộng tổng khi chốt, tránh đếm 1+2+3 thành 6.
- Mã người dùng và mã nguồn sự kiện giữ dạng chuỗi để không mất độ chính xác.
- Backend lưu sự kiện trước khi phát. Kết nối frontend bị ngắt có thể đọc lại sự kiện đã lưu theo cursor.
- Nếu không lưu được dữ liệu, backend dừng nhận sự kiện, đánh dấu phiên lỗi và báo `STORAGE_ERROR` qua health/API ngay cả khi không ghi được trạng thái lỗi vào database. Sửa dung lượng/kết nối database rồi khởi động lại backend trước khi bắt đầu phiên mới.
- Nếu tiến trình backend khởi động lại, phiên đang chạy được đánh dấu gián đoạn và giữ nguyên lịch sử; bấm Theo dõi để bắt đầu phiên mới. Bản này chạy một tiến trình backend cho mỗi database.
- Mất kết nối với TikTok có thể tạo khoảng thiếu dữ liệu; ứng dụng không cam kết lấy lại toàn bộ sự kiện nguồn trong khoảng đó.
- Dữ liệu quà không phải bảng quyết toán hay thu nhập tiền mặt.
- Thông báo desktop chỉ xin quyền sau thao tác bật của người dùng. Thông báo của bản này hoạt động khi web còn mở; chưa có dịch vụ push điện thoại khi đóng web.

## API

Xem hợp đồng chi tiết trong `docs/design.md` và kiểu dữ liệu `shared/contracts.ts`.

| API | Chức năng |
|---|---|
| `GET /api/health` | Trạng thái backend |
| `GET /api/live-sessions` | Danh sách phiên |
| `POST /api/live-sessions` | Bắt đầu theo dõi `{url, mode}` |
| `GET /api/live-sessions/:id` | Trạng thái và tổng của phiên |
| `POST /api/live-sessions/:id/stop` | Dừng |
| `GET /api/live-sessions/:id/history` | Sự kiện đã lưu |
| `GET /api/live-sessions/:id/events?after=...` | SSE có replay |
| `GET /api/live-sessions/:id/export` | Xuất CSV |
| `GET /api/live-sessions/:id/audience` | Thống kê và bảng tài khoản theo toàn phiên |
| `GET /api/live-sessions/:id/audience-export` | CSV tổng hợp toàn bộ tài khoản của phiên |

Khi `APP_TOKEN` được đặt, các API ngoài health yêu cầu header `Authorization: Bearer <token>`. Client đọc SSE bằng streaming fetch để token không nằm trong query string.

`mode: "demo"` trên API dành cho thử tích hợp backend. Giao diện có bộ demo riêng trong trình duyệt và không liệt kê các phiên demo tạo bằng API; nếu tự tạo một phiên demo qua API, hãy gọi API dừng trước khi bắt đầu LIVE thật.

## Gói mã nguồn

`npm run build` tạo lại `public/livelens-source.zip` rồi build giao diện. Nút **Tải mã nguồn** trên web tải gói này, gồm frontend, backend, cấu hình Docker và các kiểm thử. File `.env`, database, thư mục `node_modules` và thông tin triển khai riêng không được đưa vào gói.

## Kiểm tra

```bash
npm test
npm run typecheck
npm run build
```

Kiểm tra giao diện tự động khi app đang chạy (cần Python, Playwright và Chrome):

```bash
python tests/reader-ui.py http://localhost:3001
python tests/functional-ui.py http://localhost:3001
python tests/audience-ui.py http://localhost:3001
python tests/notifications-ui.py http://localhost:3001
```

Kiểm thử dùng connector giả được tiêm ở ranh giới mạng để xác minh logic thật của phiên, database, HTTP, SSE, quà combo và hủy kết nối. Nó không chứng minh rằng một phòng TikTok cụ thể đang truy cập được. Xem `docs/verification.md` để biết các kiểm tra thực tế đã chạy khi bàn giao.

## Phụ thuộc và tài liệu

- [TikTok LIVE Connector](https://ttlc.docs.isaackogan.com/) — thư viện không chính thức, bản được khóa trong package-lock.
- [Mã nguồn và giấy phép của connector](https://github.com/zerodytrash/TikTok-Live-Connector) — xem điều khoản của phụ thuộc khi phân phối hay vận hành dịch vụ.
- [Euler Stream](https://www.eulerstream.com/docs/api/websockets) — dịch vụ WebSocket/ký kết nối liên quan.

Không có API key hay dữ liệu người dùng thật được đóng gói trong source.
