# ExamPlus

Dashboard web statis untuk operasi ujian ExamPlus. Dibangun dengan HTML, CSS, JavaScript, Supabase, dan ditujukan untuk GitHub Pages.

## Konfigurasi Supabase bersama

Isi `config/supabase.json` satu kali dengan URL project dan `anonKey` Supabase. File ini menjadi sumber konfigurasi dashboard admin, portal web, APK Android, dan EXE Windows. Kunci `anon/public` memang berada di aplikasi klien dan bukan pengganti RLS; jangan pernah memasukkan `service_role`.

Web mengambil file konfigurasi saat dibuka. APK dan EXE menyertakan salinannya saat proses build, jadi setelah mengubah konfigurasi, bangun ulang aplikasi tersebut.

## Menjalankan dashboard dan portal web

Sajikan direktori ini melalui HTTP, misalnya `python -m http.server 8000`, lalu buka `http://localhost:8000`. Portal siswa tersedia di `/student.html`. Jangan membuka halaman langsung sebagai berkas lokal (`file://`) karena browser dapat membatasi pemuatan konfigurasi dan koneksi Supabase.

Untuk GitHub Pages, pilih branch dan direktori root yang berisi `index.html` pada pengaturan Pages repository. Pastikan `config/supabase.json` ikut dipublikasikan. Tidak diperlukan proses build. Supabase JS, SheetJS, Tailwind Play CDN, dan font dimuat dari CDN.

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

3. Isi URL project dan `anonKey` sekali di `config/supabase.json`, lalu masuk dengan akun tersebut.
4. Tambahkan ruang ke `public.rooms` lewat SQL Editor atau alat administrasi tepercaya sebelum membuat alokasi.

Kebijakan RLS memberi akses baca/tulis aplikasi hanya kepada akun yang tercatat di `exam_admins`. Klien anonim tidak mendapat akses ke tabel. Jangan menonaktifkan RLS dan jangan menaruh `service_role` key di kode frontend.

## Aplikasi peserta Android

1. Jalankan migrasi `supabase/migrations/20261114020000_participant_event_rpc.sql`, `supabase/migrations/20261114070000_pause_on_participant_violation.sql`, dan `supabase/migrations/20261114080000_participant_alarm_controls.sql` melalui SQL Editor.
2. Deploy endpoint peserta dengan `supabase functions deploy participant-access`. Endpoint menggunakan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` dari environment Edge Function; jangan pernah menanamkan service-role key ke APK.
3. Isi `config/supabase.json`, lalu buka `android/participant` dengan Android Studio dan sinkronkan Gradle. Gradle memasukkan file konfigurasi bersama ke assets APK.
4. Peserta masuk dengan NIS dan token pelajaran 6 digit. Ruang dan nomor kursi ditentukan dari alokasi admin; token ruang tidak dipakai untuk login peserta.
5. Untuk keluar, peserta meminta token ruang dari pengawas. Endpoint hanya menandai ujian selesai jika token tersebut cocok dengan ruang alokasi peserta. APK pengawas masuk memakai nama ruang dan `proctor_code`, bukan token ruang.
6. APK meminta izin **Tampil di atas aplikasi lain** sebelum peserta masuk ujian agar kotak kode pengawas dapat bertahan di atas aplikasi lain. Ketika peserta menekan Back, Home/Recent Apps, atau layar mati, ujian dijeda dan service foreground membunyikan alarm berulang. Volume stream alarm dinaikkan ke maksimum selama alarm, lalu dipulihkan saat alarm berhenti. Alarm berhenti setelah `proctor_code` benar atau pengawas menekan **Matikan alarm** di pemantauan dashboard; tindakan mematikan alarm saja tidak melanjutkan ujian. Kode yang salah tidak membuka ujian; percobaannya dibatasi.
7. Android tidak mengizinkan aplikasi biasa mencegah tombol power mematikan layar atau menampilkan overlay di atas layar kunci. APK mendeteksi siaran layar mati sebagai pelanggaran, tetapi kotak kode baru terlihat lagi setelah layar dibuka. Volume maksimum juga tidak dapat menjamin suara terdengar bila DND, kebijakan perangkat, atau perangkat keras membisukan stream alarm. Untuk benar-benar mengunci navigasi, perangkat harus dikelola sebagai Device Owner/DPC dan aplikasi dimasukkan ke `setLockTaskPackages`; screen pinning biasa masih dapat dihentikan pengguna.
8. Untuk APK uji, pilih **Build → Build APK(s)** di Android Studio.

Token pelajaran dibuat otomatis saat pelajaran dibuat dan dapat disalin dari daftar pelajaran. Jadwal mulai dan selesai bisa diedit untuk mengakomodasi susulan. Token bisa diganti oleh admin hanya saat pelajaran ditutup; token ruang tetap tersimpan sampai admin secara eksplisit membuat token ruang baru.

Endpoint menerima heartbeat, mencatat pelanggaran, memblokir log ujian saat APK melaporkan perpindahan aplikasi, memverifikasi `proctor_code` sebelum melanjutkan, dan memverifikasi token ruang sebelum mengakhiri ujian. Login dan upaya melanjutkan memakai pembatasan percobaan per NIS, alamat IP, dan jenis aksi. Endpoint hanya mengembalikan link pelajaran peserta yang lolos validasi; tabel tetap tertutup bagi anon. Verifikasi JWT endpoint diaktifkan; aplikasi mengirimkan anon/public key sebagai bearer token dan tidak mengirimkan service-role key.

## Aplikasi pengawas Android

APK pengawas terpisah tersedia di `android/proctor`. Buka folder itu di Android Studio; Gradle mengambil konfigurasi Supabase yang sama dari `config/supabase.json`. Pengawas masuk dengan nama ruang dan `proctor_code`, memilih pelajaran aktif, lalu memantau roster dan status peserta. Tombol **Matikan alarm** menghentikan bunyi tanpa membuka blokir; **Izinkan lanjut** mengubah peserta terblokir ke status ujian dan menghentikan alarm.

Sebelum digunakan, jalankan migrasi `supabase/migrations/20261114080000_participant_alarm_controls.sql`, lalu deploy kedua endpoint dengan `supabase functions deploy participant-access` dan `supabase functions deploy proctor-access`. APK tidak berisi `service_role`; semua data dan tindakan pengawas melewati Edge Function. Build APK dengan `android/proctor/gradlew.bat :app:assembleDebug`; hasilnya berada di `android/proctor/app/build/outputs/apk/debug/app-debug.apk`.

## Aplikasi pengawas Windows

EXE pengawas tersedia sebagai aplikasi WPF terpisah di `windows/proctor`. Aplikasi memakai `config/supabase.json` bersama dan Edge Function `proctor-access`; kode ruang disimpan di memori selama aplikasi berjalan. Pengawas masuk dengan nama ruang dan `proctor_code`, memilih pelajaran aktif, memantau status serta pelanggaran peserta, mematikan alarm, atau mengizinkan peserta melanjutkan. Jangan memasukkan `service_role` ke konfigurasi klien.

Bangun folder publikasi mandiri untuk Windows x64:

```powershell
dotnet publish windows/proctor/ExamPlusProctor.csproj -c Release -r win-x64 --self-contained true -o windows/proctor/publish
```

Salin seluruh isi `windows/proctor/publish/` ke komputer pengawas. Pastikan migrasi alarm sudah diterapkan dan Edge Functions `proctor-access` serta `participant-access` telah di-deploy.

## Portal web peserta

Portal peserta tersedia di `student.html` dan memuat konfigurasi dari `config/supabase.json` yang sama dengan dashboard dan aplikasi native.

Peserta masuk menggunakan NIS dan token pelajaran. Setelah masuk, portal menampilkan nama, ruang, nomor kursi, dan Google Forms untuk pelajaran tersebut. Portal mengirim heartbeat setiap 30 detik dan mencatat perpindahan tab saat browser berpindah ke latar belakang. Untuk keluar, peserta meminta token ruang kepada pengawas; server hanya mengakhiri ujian jika token sesuai dengan ruang alokasi. Setelah berhasil, portal membersihkan isian login dan kembali ke halaman login.

Portal web tidak dapat mengunci perangkat, memblokir tombol navigasi, atau mencegah peserta berpindah aplikasi. Gunakan aplikasi Android pada perangkat sekolah yang dikelola bila ujian memerlukan mode kios.

## Aplikasi peserta Windows

Project EXE berbasis WPF dan Microsoft WebView2 tersedia di `windows/participant`. Project ini memuat portal siswa lokal dan konfigurasi Supabase bersama, membatasi navigasi dan menu browser, serta mencegah jendela ditutup selama ujian. Saat jendela kehilangan fokus, aplikasi mencatat pelanggaran, menjeda formulir, membunyikan alarm, dan menampilkan kotak kode pengawas di atas jendela lain. Kode yang salah tidak melanjutkan ujian; aplikasi juga memeriksa tindakan **Matikan alarm** atau **Izinkan lanjut** dari panel pengawas. Alarm memakai volume suara sistem Windows.

Bangun EXE beserta file pendukung dengan runtime .NET mandiri:

```powershell
dotnet publish windows/participant/ExamPlusParticipant.csproj -c Release -r win-x64 --self-contained true
```

File publikasi tersedia di `windows/participant/bin/Release/net8.0-windows/win-x64/publish/`. Microsoft Edge WebView2 Runtime tetap harus tersedia di komputer Windows. Untuk EXE desktop, gunakan profil restricted user experience/multi-app Assigned Access pada akun dan perangkat sekolah yang dikelola. Mode single-app kiosk Windows ditujukan untuk aplikasi UWP atau Microsoft Edge; Shell Launcher dapat menjadi alternatif pada edisi Windows yang mendukungnya. Aplikasi desktop tidak dapat memblokir semua pintasan sistem seperti Alt+Tab atau Task Manager. Lihat [Assigned Access Microsoft](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/).

## Fitur dashboard

- Template Excel tersedia melalui tombol **Template Excel**. Impor CSV, XLSX, atau XLS memakai kolom wajib `nis`, `name`, dan `original_class` (atau `class`); `room` opsional dan harus cocok dengan nama ruang. Header Indonesia `nama`, `nama_lengkap`, `kelas_asal`, `kelas`, dan `ruang` juga dikenali. Berkas lama yang memiliki `device_id`/`id_perangkat` tetap diterima; data perangkat tersimpan dan tidak dihapus saat kolom itu tidak disertakan. Impor dengan NIS yang sama memperbarui siswa yang sudah ada.
- Ruang default dapat diisi pada data siswa dan digunakan saat membuat alokasi pelajaran. Admin dapat memindahkan peserta ke ruang lain khusus untuk pelajaran tertentu; perubahan ruang default tidak mengubah alokasi pelajaran yang sudah tersimpan.
- Daftar siswa dapat dicari, diurutkan menurut nama/NIS/kelas/ruang, dan difilter menurut kelas atau ruang. Siswa dapat ditambah, diedit, dan dihapus; penghapusan siswa turut menghapus alokasi serta log ujian terkait.
- Ruang dan pelajaran dapat dihapus dengan konfirmasi. Ruang yang masih memiliki alokasi tidak dapat dihapus; pelajaran harus ditutup dahulu, dan penghapusannya turut menghapus alokasi serta log terkait.
- Mode gelap/terang tersedia di halaman masuk dan dashboard, mengikuti preferensi sistem pada kunjungan pertama dan menyimpan pilihan di browser.
- Distribusi siswa lintas kelas ke ruang dengan jumlah siswa per kelas yang seimbang; nomor kursi unik per ruang dan pelajaran.
- Pembuatan ruang beserta kode rahasia pengawas dan token ruang 6 digit untuk mengakhiri ujian; pembuatan ulang token hanya dilakukan atas tindakan admin.
- Alokasi ruang disimpan per pelajaran dan tidak berubah saat pelajaran lain dibuat; pengaturan ulang alokasi meminta konfirmasi admin.
- Pembacaan roster pemetaan per pelajaran/ruang dan ekspor roster ke CSV.
- Pemantauan peserta yang dialokasikan, termasuk peserta yang belum login, status realtime, kontrol mematikan alarm jarak jauh, dan tindakan membuka blokir.
- Pembuatan pelajaran Google Forms serta aktivasi/penutupan pelajaran.
- Pengaturan admin: ganti sandi dengan verifikasi sandi saat ini, lihat sumber konfigurasi Supabase bersama, undang admin, dan cabut akses admin lain.

## Batasan skema saat ini

- Skema pelajaran hanya memiliki `is_active`, sehingga status jeda belum dapat dibedakan dari pelajaran tutup.
- Kolom `exam_logs.alarm_active` hanya mengendalikan bunyi alarm melalui polling aplikasi peserta; tombol dashboard tidak membuka blokir atau melanjutkan ujian.
- Kebijakan database pada migrasi ini ditujukan untuk admin web. Aplikasi peserta dan pengawas memakai Edge Function server-side; anon key tidak memberi akses langsung ke tabel.
- APK pengawas meminta ulang kredensial ruang pada setiap operasi; kode tidak disimpan permanen di perangkat. Gunakan `proctor_code` unik dan rahasia, bukan token ruang 6 digit.
