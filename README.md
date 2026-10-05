# عوي بترتاح 🐕

موقع نقر ساخر على طريقة popcat.click: بتختار شخصية، وبتكبس على وجهها، فبيفتح تمّه وبينبح. عدّادك الشخصي بيزيد، وبيزيد معه عدّاد الشخصية وعدّاد محافظتك من المحافظات السورية الـ١٤.

موقع ساخر للترفيه فقط.

## التشغيل محلياً

ما في build. الموقع ملفات static بس:

```bash
py -m http.server 5173
# افتح http://127.0.0.1:5173
```

- `?debug=1`: لوحة لمعايرة خط الفك ومكان الفم لكل وجه. انسخ القيم اللي بتطلع لـ`src/config.js`.
- `?local=1`: بيجبر الموقع على الوضع المحلي حتى لو مفاتيح Firebase موجودة.

## الملفات

| الملف | الوظيفة |
|---|---|
| `index.html`, `styles/main.css` | الصفحة |
| `src/main.js` | الحالة، الإدخال (ماوس، لمس متعدد، كيبورد)، والعدّادات |
| `src/face.js` | حركة الفك: تقسيم الصورة عند خط الفك، squash & stretch، ولوحة الـdebug |
| `src/audio.js` | صوت النبحة: AudioBuffer محمّل مسبقاً، وطبقة الصوت بتتغيّر ±10% بكل كبسة |
| `src/sync.js` | تجميع الكبسات وإرسالها كل ٣ ثواني، والوضع المحلي (localStorage + BroadcastChannel) |
| `src/firebase.js` | الاتصال بـFirebase Realtime Database، وبينحمّل بس إذا المفاتيح موجودة |
| `src/leaderboard.js` | ترتيب المحافظات مع أنيميشن تبديل المراكز |
| `src/config.js` | **كل الإعدادات:** مفاتيح Firebase، الشخصيات، والمحافظات |
| `database.rules.json` | قواعد الأمان |
| `scripts/process-faces.py` | قص الوجوه: إزالة الخلفية (rembg)، كشف الوجه (OpenCV)، وتصدير WebP و PNG |
| `scripts/extract-bark.py` | قص نبحة وحدة من ملف الصوت الأصلي |

## إضافة شخصية

1. حط الصورة بـ`pic/`، وضيفها لـ`FACES` بـ`scripts/process-faces.py`، وبعدين:
   ```bash
   py -3.11 -m pip install "rembg[cpu]" "opencv-python-headless<5" pillow numpy
   py -3.11 scripts/process-faces.py
   ```
2. ضيف الشخصية لـ`CHARACTERS` بـ`src/config.js`.
3. ضيف الـslug لقائمة الشخصيات المسموحة بـ`database.rules.json`، بمكانين: `characters` و `matrix`.

## Firebase: لترتيب عالمي مشترك بين كل الزوار

بدون مفاتيح، الموقع بيشتغل **محلياً**: الأرقام محفوظة على جهاز كل زائر لحاله، والنقطة الرمادية بالشريط تحت بتدل على هالوضع.

لتفعيل الترتيب المشترك:

1. افتح [console.firebase.google.com](https://console.firebase.google.com) وأنشئ مشروع جديد.
2. **Build → Realtime Database → Create database.** المنطقة مثلاً `europe-west1`، وابدأ بـlocked mode.
3. **Build → Authentication → Sign-in method:** فعّل **Anonymous**.
4. **Project settings → Your apps → Web app:** انسخ الـconfig لـ`FIREBASE` بـ`src/config.js`.
5. **Realtime Database → Rules:** الصق محتوى `database.rules.json` واكبس Publish.
6. **Authentication → Settings → Authorized domains:** ضيف `znad-odoo-dev.github.io`.

لما تشتغل، النقطة بالشريط بتصير خضرا.

### ليش Realtime Database وما استعملنا Firestore؟

- Firestore بيتحمّل تقريباً كتابة وحدة بالثانية على نفس الـdocument، وهاد ما بيكفي لعدّادات عليها ضغط عالي.
- Realtime Database ما عليها هالحد، وفيها `increment()` بيصير على السيرفر.
- كل دفعة كبسات بتتبعت بـ`update()` واحد ذرّي (atomic)، فيه كل العدّادات مع ختم الوقت.

### الحماية من الغش

- كل زائر بياخد uid مجهول (Anonymous Auth)، وكل تاب بياخد uid لحاله.
- أقصى حد **٢٠٠ كبسة بالدفعة**، ولازم يمرق **٢.٥ ثانية على الأقل** بين دفعتين من نفس الـuid. يعني الحد الأعلى تقريباً ٨٠ كبسة بالثانية.
- زيادة الـ`total` لازم تساوي عدد كبسات الدفعة، وكل عدّاد تاني ما بيقدر يزيد أكتر من هالعدد.
- أسماء الشخصيات والمحافظات لازم تكون من القائمة المسموحة.

## النشر على GitHub Pages

الموقع منشور من فرع `main` (المجلد الرئيسي). أي `git push` بيحدّث الموقع خلال دقيقة تقريباً.

## الصوت

النبحة مقصوصة من الملف اللي قدّمه صاحب المشروع ("How Dogs React When Seeing Stranger 11"). القص من الثانية ٤١.٠٧، ومعه فلتر high-pass على 180Hz، والسكربت هو `scripts/extract-bark.py`. إذا الملف `assets/sfx/bark.mp3` مش موجود، الموقع بيرجع لأصوات مولّدة بـWeb Audio.
