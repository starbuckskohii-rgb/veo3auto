# Kế Hoạch Tích Hợp Firebase & Thương Mại Hóa (veo3auto)

Tài liệu này mô tả chi tiết các bước triển khai hệ thống xác thực, quản lý bản quyền (thu phí tháng), giới hạn thiết bị (HWID) và bảo mật mã nguồn cho công cụ `veo3auto`.

## 1. Kiến Trúc Hoạt Động

*   **Xác thực (Authentication):** Sử dụng Firebase Authentication (Email/Password). Người dùng đăng nhập từ giao diện (UI) hoặc terminal.
*   **Quản lý dữ liệu (Firestore):** Lưu trữ thông tin người dùng.
    *   `uid`: ID người dùng (từ Firebase Auth).
    *   `email`: Email người dùng.
    *   `expirationDate`: Ngày hết hạn bản quyền (Timestamp). Được cập nhật thủ công trên Firebase Console bởi thiết bị Admin sau khi nhận thanh toán.
    *   `hwid`: Mã định danh phần cứng (Hardware ID). Dùng để khóa thiết bị.
*   **Luồng kiểm tra (Validation):**
    1.  Người dùng nhập Email/Password.
    2.  Hệ thống tạo mã phần cứng (HWID) của máy hiện tại.
    3.  Ứng dụng đăng nhập với Firebase và lấy thông tin user từ Firestore.
    4.  **Kiểm tra hạn sử dụng:** `expirationDate` có lớn hơn thời gian hiện tại không? (Nếu không -> Báo hết hạn bản quyền).
    5.  **Kiểm tra HWID:**
        *   Nếu `hwid` trên Firebase đang trống: Cập nhật `hwid` của máy hiện tại lên Firebase (Gắn khóa máy lần đầu).
        *   Nếu `hwid` trên Firebase đã có giá trị: So sánh với `hwid` hiện tại. Nếu khác nhau -> Chặn quyền truy cập (Báo lỗi: Tài khoản đang được sử dụng ở máy khác).
*   **Quản trị (Admin):** Quản lý hoàn toàn thông qua Firebase Console (Sửa đổi `expirationDate` và reset `hwid` nếu người dùng đổi máy/cài lại Win).

## 2. Các Giai Đoạn Triển Khai

### Giai Đoạn 1: Thiết Lập Firebase & Cấu Trúc Dữ Liệu
*   [ ] Người dùng (bạn) cần tạo Project trên Firebase, bật **Authentication (Email/Password)** và tạo **Firestore Database**.
*   [ ] Lấy thông tin cấu hình Firebase (Firebase Config cho Web/Client Auth).
*   [ ] Định nghĩa Firestore Rules để bảo mật dữ liệu (Chỉ user có UID trùng khớp mới đọc được dữ liệu của mình, không có quyền sửa `expirationDate` hay `hwid` từ client). Hoặc tích hợp qua Firebase Admin SDK trên Node.js backend của tool để an toàn nhất.

### Giai Đoạn 2: Tích Hợp Đăng Nhập & Kiểm Tra Bản Quyền vào Tool
*   [ ] Cài đặt các thư viện cần thiết: `firebase` (Client authentication), `firebase-admin` (nếu dùng backend Node.js để check), và `node-machine-id` (để lấy HWID bảo mật).
*   [ ] Xây dựng file `auth.js` cho nhiệm vụ: login, sinh HWID, và kết nối lên Firestore kiểm tra.
*   [ ] Tích hợp `auth.js` vào file khởi chạy của hệ thống (như `server.js` hoặc `index.js`). Tool sẽ dừng ngay lập tức (hoặc chặn truy cập API) nếu chưa đăng nhập, hết hạn hợp đồng, hoặc sai HWID.
*   [ ] (Tùy chọn) Thêm một giao diện đăng nhập nhỏ trên web `public/index.html` nếu quy trình sử dụng bắt đầu từ web, hoặc một terminal prompt cho người nhập.

### Giai Đoạn 3: Đóng Gói và Mã Hóa Chống Thay Đổi (Anti-Crack)
*   [ ] Sử dụng `javascript-obfuscator`: Làm rốí/mã hóa logic toàn bộ mã nguồn (`worker.js`, `orchestrator.js`, `server.js`...) thành các đoạn mã không thể đọc hiểu. Kẻ gian dù lấy được file JS cũng không thể dò ra cơ chế sinh HWID hoặc nơi check Firebase nội bộ.
*   [ ] Đóng gói với `pkg` (hoặc `caxa`, `boxednode`): Biến toàn bộ bộ mã nguồn Node.js (cùng với obfuscated code) thành 1 tệp `.exe` thực thi duy nhất dành cho Windows. 
*   [ ] Người dùng cuối sẽ chỉ nhận 1 file `veo3auto.exe`. Khi chạy, nó sẽ tự bật server cục bộ, có bảng đăng nhập, và không ai mò được source code.

## 3. Các Bước Cần Người Dùng Trợ Giúp (User Action Required)

Để bắt đầu bước sang cấu hình (IMPLEMENTATION), **Bạn cần chuẩn bị và cung cấp cho tôi**:
1.  Truy cập [Firebase Console](https://console.firebase.google.com/), tạo một dự án.
2.  Bật chức năng xác thực **Email/Password** trong Authentication > Sign-in method.
3.  Tạo bảng dữ liệu **Firestore Database** (chọn start in locked mode).
4.  Đi tới Cài đặt dự án (Project settings) > Tài khoản dịch vụ (Service Accounts) -> **Generate new private key**. (Tải tệp JSON chứa khóa bảo mật về, chúng ta sẽ cần tệp này cho Firebase Admin SDK hoạt động trên Node.js backend).
5.  Trang Cài đặt dự án > General -> Thêm 1 Web App và lấy **Firebase Config object** (apiKey, authDomain...) nếu cần dùng cho phía UI HTML.

---
Vui lòng xem lại bản kế hoạch và cho tôi biết nếu bạn đồng ý. Nếu đồng ý, chúng ta sẽ tiến hành tạo ra các file bảo mật mã hóa và chèn Firebase SDK ngay.
