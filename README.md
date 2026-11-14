# ExamPlus

Dashboard web statis untuk operasi ujian ExamPlus. Dibangun dengan HTML, CSS, JavaScript, Supabase, dan ditujukan untuk GitHub Pages.

## Menjalankan dashboard

Sajikan direktori ini melalui HTTP, misalnya `python -m http.server 8000`, lalu buka `http://localhost:8000`. Tekan **Configure Supabase** dan masukkan URL project serta kunci `anon`/public. Konfigurasi disimpan di local storage browser. Jangan pernah memasukkan `service_role` key ke dashboard.

Untuk GitHub Pages, pilih branch dan direktori root yang berisi `index.html` pada pengaturan Pages repository. Tidak diperlukan proses build. Supabase JS, SheetJS, Tailwind Play CDN, dan font dimuat dari CDN.

## Menyiapkan Supabase

Jalankan `supabase/migrations/20261112100000_examplus_schema.sql` melalui Supabase SQL Editor. Migrasi membuat tabel, relasi, constraint, indeks, kebijakan RLS untuk admin, dan menambahkan `exam_logs` ke publikasi Realtime jika publikasi tersedia.

Jalankan juga `supabase/migrations/20261114050000_session_participant_tokens.sql` agar dashboard dapat membuat token pelajaran unik untuk setiap pelajaran.

Jalankan `supabase/migrations/20261114060000_student_default_rooms.sql` untuk menambahkan ruang default pada data siswa. Kolom `device_id` lama tetap dipertahankan di database agar datanya tidak hilang.

Jika project sudah memiliki trigger `on_auth_user_created` yang memanggil `public.handle_new_user()`, jalankan juga `supabase/migrations/20261114000000_profiles_for_auth_trigger.sql`. Migrasi ini menyiapkan tabel `profiles` yang diharapkan fungsi trigger dan tidak memberi akses langsung ke klien. Pastikan tipe enum `public.user_role` sudah ada dengan nilai yang diharapkan fungsi tersebut.

Jika pembuatan user masih gagal karena tipe `user_role` tidak ditemukan, jalankan `supabase/migrations/20261114010000_fix_handle_new_user_search_path.sql`. Fungsi trigger mengualifikasi `public.user_role` secara eksplisit sehingga tidak bergantung pada `search_path` saat autentikasi membuat user.

Untuk memakai pengaturan admin, jalankan `supabase/migrations/20261114030000_admin_settings.sql` dan `supabase/migrations/20261114040000_workspace_settings.sql`, lalu deploy `supabase functions deploy admin-management`. Endpoint admin memverifikasi access token dan keanggotaan `exam_admins` sebelum mengundang atau mencabut admin. Undangan email memerlukan SMTP Supabase yang aktif. Pencabutan tidak menghapus akun Auth, tidak mengizinkan admin mencabut dirinya sendiri, dan mempertahankan setidaknya satu admin. Preferensi workspace disimpan di database sehingga berlaku bagi semua admin.

1. Buat akun admin melalui Supabase **Authentication → Users**.
2. Beri akun tersebut akses admin melalui SQL Editor:

   ```sql
   insert into public.exam_admins (user_id)
   select id
   from auth.users
   where email = 'admin@example.com'
   on conflict (user_id) do nothing;
   ```

3. Masukkan URL project dan `anon`/public key ke pengaturan dashboard, lalu masuk dengan akun tersebut.
4. Tambahkan ruang ke `public.rooms` lewat SQL Editor atau alat administrasi tepercaya sebelum membuat alokasi.

Kebijakan RLS memberi akses baca/tulis aplikasi hanya kepada akun yang tercatat di `exam_admins`. Klien anonim tidak mendapat akses ke tabel. Jangan menonaktifkan RLS dan jangan menaruh `service_role` key di kode frontend.

## Aplikasi peserta Android

1. Jalankan migrasi `supabase/migrations/20261114020000_participant_event_rpc.sql` melalui SQL Editor.
2. Deploy endpoint peserta dengan `supabase functions deploy participant-access`. Endpoint menggunakan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` dari environment Edge Function; jangan pernah menanamkan service-role key ke APK.
3. Buka `android/participant` dengan Android Studio, sinkronkan Gradle, lalu jalankan aplikasi. Masukkan Project URL dan anon/public key pada layar pengaturan aplikasi.
4. Peserta masuk dengan NIS dan token pelajaran 6 digit. Ruang dan nomor kursi ditentukan dari alokasi admin; token ruang tidak dipakai untuk login peserta.
5. Untuk keluar, peserta meminta token ruang dari pengawas. Endpoint hanya menandai ujian selesai jika token tersebut cocok dengan ruang alokasi peserta. Token ruang juga menjadi kredensial pengawas untuk pemantauan; aplikasi proktor belum tersedia.
6. Untuk APK rilis, gunakan DPC/device-owner yang memasukkan `com.examplus.participant` ke daftar `setLockTaskPackages`. Tanpa itu, `startLockTask()` hanya meminta screen pinning yang masih bisa dihentikan pengguna. Immersive mode dan FLAG_SECURE tidak memblokir notification shade secara menyeluruh, dan FLAG_SECURE bukan pengganti kebijakan kiosk perangkat terkelola.
7. Untuk APK uji, pilih **Build → Build APK(s)** di Android Studio.

Token pelajaran dibuat otomatis saat pelajaran dibuat dan dapat disalin dari daftar pelajaran. Jadwal mulai dan selesai bisa diedit untuk mengakomodasi susulan. Token bisa diganti oleh admin hanya saat pelajaran ditutup; token ruang tetap tersimpan sampai admin secara eksplisit membuat token ruang baru.

Endpoint menerima heartbeat, mencatat pelanggaran saat pengguna meninggalkan aplikasi, dan memverifikasi token ruang sebelum menandai ujian selesai. Maksimal lima percobaan masuk diizinkan per NIS dan alamat IP dalam jendela 10 menit; percobaan berikutnya dibatasi selama 10 menit. Endpoint hanya mengembalikan link pelajaran peserta yang lolos validasi; tabel tetap tertutup bagi anon. Verifikasi JWT endpoint diaktifkan; aplikasi mengirimkan anon/public key sebagai bearer token dan tidak mengirimkan service-role key. Fokus-loss menaikkan penghitung pelanggaran, tetapi belum memblokir peserta otomatis karena ambang blokir perlu ditetapkan.

## Fitur dashboard

- Template Excel tersedia melalui tombol **Template Excel**. Impor CSV, XLSX, atau XLS memakai kolom wajib `nis`, `name`, dan `original_class` (atau `class`); `room` opsional dan harus cocok dengan nama ruang. Header Indonesia `nama`, `nama_lengkap`, `kelas_asal`, `kelas`, dan `ruang` juga dikenali. Berkas lama yang memiliki `device_id`/`id_perangkat` tetap diterima; data perangkat tersimpan dan tidak dihapus saat kolom itu tidak disertakan. Impor dengan NIS yang sama memperbarui siswa yang sudah ada.
- Ruang default dapat diisi pada data siswa dan digunakan saat membuat alokasi pelajaran. Admin dapat memindahkan peserta ke ruang lain khusus untuk pelajaran tertentu; perubahan ruang default tidak mengubah alokasi pelajaran yang sudah tersimpan.
- Siswa dapat ditambah manual dan data siswa/ruang dapat diedit dari dashboard. Penghapusan permanen belum disediakan agar alokasi dan log ujian tidak terhapus tanpa sengaja.
- Distribusi siswa lintas kelas ke ruang dengan jumlah siswa per kelas yang seimbang; nomor kursi unik per ruang dan pelajaran.
- Pembuatan ruang beserta kode pengawas dan token ruang 6 digit untuk pengawas/pengakhiran ujian; pembuatan ulang token hanya dilakukan atas tindakan admin.
- Alokasi ruang disimpan per pelajaran dan tidak berubah saat pelajaran lain dibuat; pengaturan ulang alokasi meminta konfirmasi admin.
- Pembacaan roster pemetaan per pelajaran/ruang dan ekspor roster ke CSV.
- Pemantauan peserta yang dialokasikan, termasuk peserta yang belum login, status realtime, dan tindakan unblock.
- Pembuatan pelajaran Google Forms serta aktivasi/penutupan pelajaran.
- Pengaturan admin: ganti sandi dengan verifikasi sandi saat ini, perbarui koneksi Supabase, undang admin, dan cabut akses admin lain.

## Batasan skema saat ini

- Skema pelajaran hanya memiliki `is_active`, sehingga status jeda belum dapat dibedakan dari pelajaran tutup.
- `exam_logs` belum memiliki kanal perintah jarak jauh. Dashboard tidak mengklaim bahwa mengubah status log dapat memaksa aplikasi peserta logout. Fitur logout jarak jauh memerlukan kanal perintah dan listener di aplikasi peserta.
- Kebijakan database pada migrasi ini ditujukan untuk admin web. Aplikasi peserta memakai Edge Function server-side; aplikasi proktor belum diimplementasikan.
- Aplikasi proktor belum diimplementasikan. Token ruang ditetapkan sebagai kredensial masuk/pemantauan pengawas sekaligus token keluar peserta. Master ruang masih menyimpan `proctor_code` sebagai kredensial terpisah; apakah aplikasi proktor juga meminta kode tambahan akan diputuskan saat modul proktor dibuat.
