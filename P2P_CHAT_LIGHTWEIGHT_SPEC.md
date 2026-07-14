# P2P Encrypted Chat — Lightweight (v1)

> Bản **zero hạ tầng tuyệt đối**: 1 file `.html` mở trực tiếp (`file://`), không deploy,
> không signaling server, không tracker. 2 bên trao "mã kết nối" thủ công qua Zalo/email.
> Đây là fallback / bản tối giản của `P2P_ENCRYPTED_CHAT_SPEC.md`.

---

## 1. Mục tiêu & phạm vi

**Mục tiêu**
- Chat 1-1 mã hoá, tin nhắn đi **P2P trực tiếp** qua WebRTC DataChannel.
- **Không có bất kỳ server nào của mình** — signaling làm thủ công bằng copy-paste.
- Sản phẩm = **1 file HTML duy nhất**, gửi qua Zalo là dùng được.

**Trong phạm vi**
- Chat text 1-1, phiên (session-based): mở file → kết nối → chat → đóng là xong.
- Passphrase do app sinh ra, dùng làm **key mã hoá tầng app** (AES-GCM).

**Ngoài phạm vi (cố tình bỏ để giữ lightweight)**
- Lưu lịch sử lâu dài (tin chỉ nằm trong RAM, đóng tab là mất — nói rõ với user).
- Offline queue / sync, đa thiết bị, group, identity lâu dài, Double Ratchet.
- Tự động reconnect (rớt mạng = làm lại thủ tục paste).

---

## 2. Kiến trúc

| Layer      | Lựa chọn                                                       |
|------------|----------------------------------------------------------------|
| Đóng gói   | Vite + `vite-plugin-singlefile` → 1 file `.html`, không CDN    |
| Transport  | WebRTC DataChannel (reliable, ordered)                         |
| Signaling  | **Thủ công**: copy-paste SDP qua Zalo/email                    |
| ICE        | Non-trickle (gom đủ candidates rồi mới xuất chuỗi) + STUN công cộng |
| Crypto     | Passphrase → HKDF → AES-GCM 256, WebCrypto (`crypto.subtle`)   |
| Storage    | Không — in-memory only                                         |

**Lưu ý môi trường**: Chrome/Firefox coi `file://` là secure context nên `crypto.subtle`
và WebRTC chạy bình thường khi mở file trực tiếp.

**STUN**: dùng STUN công cộng (vd `stun.l.google.com:19302`) — không phải deploy gì.
Chat trong cùng LAN thì host candidates tự đủ, khỏi cần cả STUN.

---

## 3. Passphrase — vừa là "vé vào cửa", vừa là key

App tự sinh passphrase đủ entropy (vd 4 từ: `mèo-núi-cà-phê-73`), **không cho user tự nghĩ**.

```
passphrase
 ├─ HKDF(info="sdp")  → key mã hoá blob SDP   (bảo vệ mã kết nối khi đi qua Zalo)
 └─ HKDF(info="msg")  → key AES-GCM tin nhắn  (mã hoá mọi message trước khi vào DataChannel)
```

- SDP chứa IP của 2 máy → **mã hoá blob SDP** trước khi đưa user copy, để Zalo/email
  chỉ thấy ciphertext. Passphrase thì trao qua kênh khác hoặc đọc miệng.
- Tin nhắn mã hoá AES-GCM ở tầng app **trước khi** gửi, độc lập với DTLS của WebRTC.
- Mỗi message 1 IV random (12 byte), đóng gói `iv ‖ ciphertext`, base64 nếu cần.

---

## 4. Flow kết nối (3 lần trao đổi thủ công)

```
A (host)                                B (guest)
────────                                ─────────
1. Bấm "Tạo phòng"
   → sinh passphrase, hiện to rõ
   → createOffer, đợi ICE gathering
     complete (non-trickle)
   → mã hoá SDP offer → CHUỖI-A
2. Gửi B: passphrase (kênh 1)
         + CHUỖI-A   (kênh 2, Zalo/email)
                                        3. Nhập passphrase + paste CHUỖI-A
                                           → giải mã, setRemoteDescription
                                           → createAnswer, đợi ICE complete
                                           → mã hoá SDP answer → CHUỖI-B
                                        4. Gửi CHUỖI-B về cho A
5. Paste CHUỖI-B → setRemoteDescription
   → DataChannel mở → chat
```

- **Non-trickle bắt buộc**: đợi `icegatheringstatechange === 'complete'` rồi mới lấy
  `localDescription` — để mỗi chiều chỉ paste **1 lần duy nhất**.
- **Nén chuỗi**: SDP thô ~2KB; `CompressionStream('deflate-raw')` + base64url để chuỗi
  ngắn lại đáng kể trước khi mã hoá. Vẫn dài (vài trăm ký tự) — chấp nhận, đã cảnh báo UX.
- SDP là ephemeral (ICE candidate + DTLS fingerprint theo phiên) → **không tái sử dụng
  được**, mỗi lần kết nối là paste lại từ đầu. Đây là bản chất của cách này, không phải bug.

---

## 5. UX

- 2 màn duy nhất: **Kết nối** (tạo phòng / tham gia) và **Chat**.
- Nút copy 1 chạm cho chuỗi; textarea paste to, tự trim khoảng trắng/xuống dòng
  (Zalo hay chèn linh tinh khi gửi chuỗi dài).
- Trạng thái kết nối hiện rõ: `đang gom địa chỉ… → chờ mã bên kia → đang nối → đã nối`.
- Rớt kết nối → banner "Mất kết nối — cần tạo phiên mới" + nút làm lại. Không hứa reconnect.
- Cảnh báo ngay màn đầu: *"Tin nhắn không được lưu — đóng tab là mất."*

---

## 6. Trade-offs phải nói với user

1. **UX signaling tệ** — mỗi phiên phải gửi tay 2 chuỗi dài. Đây là giá của zero hạ tầng;
   muốn đỡ thì dùng bản Trystero (spec chính).
2. **NAT khó (symmetric NAT / mạng công ty chặn UDP)** → không có TURN thì ~10–15% cặp mạng
   không nối được. Không có cách free tuyệt đối; fail thì hiện thông báo tử tế.
3. **Không forward secrecy** — 1 passphrase cho cả phiên; lộ passphrase = lộ phiên đó.
   Giảm thiểu: mỗi phiên passphrase mới (app sinh mới mỗi lần tạo phòng).
4. **Không xác thực danh tính** — ai có passphrase + chuỗi là nối được. Kênh trao đổi
   (Zalo) chính là "danh tính". Chấp nhận với use-case 2 người quen hẹn nhau chat.
5. **Rớt là làm lại** — không auto-reconnect trong v1.

---

## 7. Lộ trình

- **M1 — Spike**: 2 tab cùng máy, paste offer/answer thủ công (plaintext), DataChannel nói chuyện được.
- **M2 — Crypto**: HKDF tách 2 key, mã hoá SDP blob + AES-GCM message, nén chuỗi.
- **M3 — Đóng gói + UX**: single-file build, 2 màn UI, copy/paste tiện, test 2 máy khác mạng thật.

---

*Lightweight v1 — fallback của spec chính, review trước khi code.*
