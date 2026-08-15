Import Proyek ke Vercel
Buka Vercel Dashboard dan login (disarankan menggunakan akun GitHub).
Klik tombol Add New... > pilih Project.
Pilih repository rianshop-fullstack lalu klik Import.
- Masukkan Environment Variables
Sebelum mengklik tombol Deploy, buka menu Environment Variables di halaman setup Vercel, lalu tambahkan 6 variabel berikut:
          Key         :    Value (Sesuaikan Data Kamu)
   TURSO_DATABASE_URL = libsql://nama-database-kamu.turso.io
   TURSO_AUTH_TOKEN   = Token autentikasi dari Turso DB
   ADMIN_USERNAME     = admin (Username login admin)
   ADMIN_PASSWORD     = password_admin_kamu(bikin aja terserah)
   JWT_SECRET         = secret_jwt_rianshop_2026
   WA_GATEWAY_TOKEN   = Token dari provider WA Gateway (Fonnte/Wablas)

baru jalankan tekan deploy
