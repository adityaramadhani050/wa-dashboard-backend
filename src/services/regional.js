// Deteksi lokasi customer -> provinsi -> regional cabang (Barat / Timur).
//
// Strategi: kamus kota/kabupaten/alias dulu (cepat, gratis, deterministik),
// lalu AI Gemini bila kamus tidak mengenali teksnya. Pulau Jawa terbelah dua
// regional (Banten/DKI/Jabar = Barat, Jateng/DIY/Jatim = Timur), jadi kota-kota
// Jawa dibuat lengkap; di luar Jawa pulau sudah menentukan regional sehingga
// cukup nama pulau + kota utama.
import { generate, aiEnabled, parseJsonLoose } from './llm.js';

export const REGION_LABEL = { barat: 'Barat', timur: 'Timur' };

// 38 provinsi -> regional
export const PROVINCE_REGION = {
  'Aceh': 'barat',
  'Sumatera Utara': 'barat',
  'Sumatera Barat': 'barat',
  'Riau': 'barat',
  'Kepulauan Riau': 'barat',
  'Jambi': 'barat',
  'Sumatera Selatan': 'barat',
  'Kepulauan Bangka Belitung': 'barat',
  'Bengkulu': 'barat',
  'Lampung': 'barat',
  'Banten': 'barat',
  'DKI Jakarta': 'barat',
  'Jawa Barat': 'barat',
  'Kalimantan Barat': 'barat',
  'Kalimantan Tengah': 'barat',
  'Kalimantan Selatan': 'barat',
  'Kalimantan Timur': 'barat',
  'Kalimantan Utara': 'barat',
  'Jawa Tengah': 'timur',
  'DI Yogyakarta': 'timur',
  'Jawa Timur': 'timur',
  'Bali': 'timur',
  'Nusa Tenggara Barat': 'timur',
  'Nusa Tenggara Timur': 'timur',
  'Sulawesi Utara': 'timur',
  'Gorontalo': 'timur',
  'Sulawesi Tengah': 'timur',
  'Sulawesi Barat': 'timur',
  'Sulawesi Selatan': 'timur',
  'Sulawesi Tenggara': 'timur',
  'Maluku': 'timur',
  'Maluku Utara': 'timur',
  'Papua': 'timur',
  'Papua Barat': 'timur',
  'Papua Barat Daya': 'timur',
  'Papua Tengah': 'timur',
  'Papua Pegunungan': 'timur',
  'Papua Selatan': 'timur',
};

// Kata kunci per provinsi: nama/singkatan provinsi + kota/kabupaten/alias.
// Kata umum yang rawan salah tangkap (mis. "batu", "metro", "buru") hanya
// dipakai dalam bentuk lengkap ("kota batu", "kota metro").
const PROVINCE_KEYWORDS = {
  'Aceh': ['aceh', 'nad', 'nanggroe aceh darussalam', 'banda aceh', 'lhokseumawe', 'langsa', 'sabang', 'meulaboh', 'bireuen', 'takengon', 'aceh besar', 'pidie'],
  'Sumatera Utara': ['sumut', 'sumatra utara', 'sumatera utara', 'medan', 'binjai', 'pematang siantar', 'pematangsiantar', 'siantar', 'tebing tinggi', 'deli serdang', 'sibolga', 'padang sidempuan', 'padangsidimpuan', 'tanjung balai', 'tanjungbalai', 'kisaran', 'rantau prapat', 'rantauprapat', 'labuhanbatu', 'labuhan batu', 'nias', 'kabanjahe', 'berastagi', 'brastagi', 'samosir', 'toba', 'langkat', 'asahan', 'serdang bedagai', 'lubuk pakam', 'karo', 'dairi', 'tapanuli'],
  'Sumatera Barat': ['sumbar', 'sumatra barat', 'sumatera barat', 'padang', 'bukittinggi', 'bukit tinggi', 'payakumbuh', 'solok', 'sawahlunto', 'pariaman', 'padang panjang', 'pesisir selatan', 'agam', 'pasaman', 'dharmasraya', 'mentawai', 'tanah datar', 'sijunjung', 'batusangkar'],
  'Riau': ['riau', 'pekanbaru', 'pakanbaru', 'dumai', 'kampar', 'bengkalis', 'siak', 'rokan hilir', 'rokan hulu', 'indragiri hilir', 'indragiri hulu', 'pelalawan', 'kuantan singingi', 'tembilahan', 'rengat', 'bagansiapiapi', 'pangkalan kerinci'],
  'Kepulauan Riau': ['kepri', 'kepulauan riau', 'batam', 'tanjung pinang', 'tanjungpinang', 'bintan', 'karimun', 'tanjung balai karimun', 'natuna', 'lingga', 'anambas'],
  'Jambi': ['jambi', 'sungai penuh', 'kerinci', 'muaro jambi', 'muara bungo', 'bungo', 'tebo', 'merangin', 'bangko', 'sarolangun', 'batanghari', 'batang hari', 'tanjung jabung', 'kuala tungkal'],
  'Sumatera Selatan': ['sumsel', 'sumatra selatan', 'sumatera selatan', 'palembang', 'prabumulih', 'lubuklinggau', 'lubuk linggau', 'pagar alam', 'pagaralam', 'ogan komering ilir', 'ogan komering ulu', 'ogan ilir', 'muara enim', 'lahat', 'banyuasin', 'musi banyuasin', 'musi rawas', 'baturaja', 'kayu agung', 'kayuagung', 'sekayu', 'empat lawang', 'pali'],
  'Kepulauan Bangka Belitung': ['babel', 'bangka belitung', 'bangka', 'belitung', 'pangkal pinang', 'pangkalpinang', 'tanjung pandan', 'tanjungpandan', 'sungailiat', 'muntok', 'toboali'],
  'Bengkulu': ['bengkulu', 'rejang lebong', 'curup', 'mukomuko', 'muko muko', 'kaur', 'seluma', 'kepahiang', 'lebong', 'manna'],
  'Lampung': ['lampung', 'bandar lampung', 'bandarlampung', 'kota metro', 'pringsewu', 'pesawaran', 'tanggamus', 'way kanan', 'tulang bawang', 'mesuji', 'kalianda', 'kotabumi', 'gunung sugih', 'liwa', 'menggala', 'natar', 'way jepara'],
  'Banten': ['banten', 'serang', 'cilegon', 'tangerang', 'tangerang selatan', 'tangsel', 'lebak', 'pandeglang', 'rangkasbitung', 'bsd', 'serpong', 'ciputat', 'pamulang', 'karawaci', 'cikupa', 'balaraja', 'tigaraksa', 'bintaro', 'gading serpong', 'alam sutera', 'cipondoh', 'anyer', 'labuan banten', 'merak'],
  'DKI Jakarta': ['dki', 'dki jakarta', 'jakarta', 'jkt', 'jakarta pusat', 'jakarta utara', 'jakarta barat', 'jakarta selatan', 'jakarta timur', 'jakpus', 'jakut', 'jakbar', 'jaksel', 'jaktim', 'kepulauan seribu', 'kebayoran', 'cengkareng', 'kelapa gading', 'tanjung priok', 'cilandak', 'pasar minggu', 'menteng', 'cakung', 'cempaka putih', 'pluit', 'pondok indah', 'kemang', 'tebet', 'kalideres', 'grogol', 'cawang', 'duren sawit', 'jatinegara', 'kramat jati', 'pulo gadung', 'ciracas', 'pasar rebo', 'jagakarsa', 'mampang', 'pesanggrahan', 'kembangan', 'tambora', 'penjaringan', 'koja', 'cilincing', 'sunter', 'senen', 'gambir', 'tanah abang', 'sudirman', 'kuningan jakarta', 'pantai indah kapuk', 'pik'],
  'Jawa Barat': ['jabar', 'jawa barat', 'jawabarat', 'bandung', 'bandung barat', 'bekasi', 'bogor', 'ciamis', 'cianjur', 'cirebon', 'garut', 'indramayu', 'karawang', 'kuningan', 'majalengka', 'pangandaran', 'purwakarta', 'subang', 'sukabumi', 'sumedang', 'tasikmalaya', 'tasik', 'banjar', 'cimahi', 'depok', 'cikarang', 'cibubur', 'cileungsi', 'cibinong', 'puncak bogor', 'lembang', 'soreang', 'jatinangor', 'pelabuhan ratu', 'pelabuhanratu', 'cikampek', 'bantar gebang', 'bantargebang', 'cileunyi', 'rancaekek', 'majalaya', 'padalarang', 'ciawi', 'sentul', 'parung', 'cicurug', 'cibadak', 'jatiasih', 'tambun', 'cibitung', 'babelan', 'harapan indah', 'kota baru parahyangan', 'arjawinangun', 'kadipaten', 'jatiwangi', 'losari cirebon', 'pamanukan', 'jalancagak'],
  'Kalimantan Barat': ['kalbar', 'kalimantan barat', 'pontianak', 'singkawang', 'ketapang', 'sambas', 'sanggau', 'sintang', 'kubu raya', 'mempawah', 'kapuas hulu', 'putussibau', 'sekadau', 'melawi', 'landak', 'ngabang', 'bengkayang', 'kayong utara'],
  'Kalimantan Tengah': ['kalteng', 'kalimantan tengah', 'palangkaraya', 'palangka raya', 'sampit', 'kotawaringin', 'kotawaringin barat', 'kotawaringin timur', 'pangkalan bun', 'kuala kapuas', 'katingan', 'muara teweh', 'barito', 'barito utara', 'barito selatan', 'barito timur', 'buntok', 'tamiang layang', 'seruyan', 'sukamara', 'lamandau', 'gunung mas', 'pulang pisau'],
  'Kalimantan Selatan': ['kalsel', 'kalimantan selatan', 'banjarmasin', 'banjarbaru', 'martapura', 'kotabaru', 'tanah bumbu', 'batulicin', 'tanah laut', 'pelaihari', 'barabai', 'hulu sungai selatan', 'hulu sungai tengah', 'hulu sungai utara', 'amuntai', 'kandangan', 'tabalong', 'tanjung tabalong', 'balangan', 'paringin', 'tapin', 'barito kuala', 'marabahan'],
  'Kalimantan Timur': ['kaltim', 'kalimantan timur', 'samarinda', 'balikpapan', 'bontang', 'kutai kartanegara', 'kukar', 'tenggarong', 'kutai timur', 'kutim', 'sangatta', 'sangata', 'kutai barat', 'sendawar', 'berau', 'tanjung redeb', 'paser', 'tanah grogot', 'penajam', 'penajam paser utara', 'ikn', 'ibu kota nusantara', 'mahakam ulu'],
  'Kalimantan Utara': ['kaltara', 'kalimantan utara', 'tarakan', 'tanjung selor', 'nunukan', 'malinau', 'bulungan', 'tana tidung'],
  'Jawa Tengah': ['jateng', 'jawa tengah', 'jawatengah', 'semarang', 'solo', 'surakarta', 'banjarnegara', 'banyumas', 'purwokerto', 'batang', 'blora', 'boyolali', 'brebes', 'cilacap', 'demak', 'grobogan', 'purwodadi', 'jepara', 'karanganyar', 'kebumen', 'kendal', 'klaten', 'kudus', 'magelang', 'pati', 'pekalongan', 'pemalang', 'purbalingga', 'purworejo', 'rembang', 'sragen', 'sukoharjo', 'tegal', 'slawi', 'temanggung', 'wonogiri', 'wonosobo', 'salatiga', 'ungaran', 'kartasura', 'ambarawa', 'cepu', 'gombong', 'majenang', 'bumiayu', 'kajen', 'mungkid', 'muntilan', 'delanggu', 'kroya', 'ajibarang', 'tawangmangu', 'palur', 'colomadu', 'grogol sukoharjo', 'weleri', 'kaliwungu', 'mranggen', 'bawen', 'banyubiru'],
  'DI Yogyakarta': ['diy', 'yogyakarta', 'yogya', 'yogja', 'jogja', 'jogjakarta', 'jogya', 'djogja', 'daerah istimewa yogyakarta', 'di yogyakarta', 'bantul', 'gunungkidul', 'gunung kidul', 'kulon progo', 'kulonprogo', 'sleman', 'wonosari', 'wates', 'godean', 'kalasan', 'depok sleman', 'piyungan', 'kaliurang'],
  'Jawa Timur': ['jatim', 'jawa timur', 'jawatimur', 'surabaya', 'sby', 'malang', 'sidoarjo', 'bangkalan', 'banyuwangi', 'blitar', 'bojonegoro', 'bondowoso', 'gresik', 'jember', 'jombang', 'kediri', 'lamongan', 'lumajang', 'madiun', 'magetan', 'mojokerto', 'nganjuk', 'ngawi', 'pacitan', 'pamekasan', 'pasuruan', 'ponorogo', 'probolinggo', 'sampang', 'situbondo', 'sumenep', 'trenggalek', 'tuban', 'tulungagung', 'kota batu', 'batu malang', 'madura', 'kepanjen', 'pare kediri', 'caruban', 'bangil', 'lawang', 'porong', 'krian', 'waru sidoarjo', 'genteng banyuwangi', 'kraksaan', 'kencong', 'ambulu', 'puger', 'singosari', 'turen', 'dampit', 'gempol', 'pandaan', 'babat', 'kertosono', 'ngoro', 'mojosari', 'tanggulangin'],
  'Bali': ['bali', 'denpasar', 'badung', 'bangli', 'buleleng', 'singaraja', 'gianyar', 'jembrana', 'karangasem', 'amlapura', 'klungkung', 'semarapura', 'tabanan', 'kuta', 'ubud', 'seminyak', 'canggu', 'nusa dua', 'jimbaran', 'sanur', 'nusa penida', 'mengwi', 'lovina', 'kintamani', 'tanah lot'],
  'Nusa Tenggara Barat': ['ntb', 'nusa tenggara barat', 'mataram', 'lombok', 'lombok barat', 'lombok tengah', 'lombok timur', 'lombok utara', 'bima', 'dompu', 'sumbawa', 'sumbawa barat', 'sumbawa besar', 'praya', 'selong', 'gerung', 'senggigi', 'taliwang'],
  'Nusa Tenggara Timur': ['ntt', 'nusa tenggara timur', 'kupang', 'flores', 'labuan bajo', 'labuanbajo', 'ende', 'maumere', 'sikka', 'manggarai', 'ruteng', 'bajawa', 'ngada', 'larantuka', 'flores timur', 'atambua', 'belu', 'soe', 'alor', 'kalabahi', 'rote', 'rote ndao', 'sumba', 'waingapu', 'sumba barat', 'sumba timur', 'sabu raijua', 'lembata', 'nagekeo', 'timor tengah selatan', 'timor tengah utara', 'kefamenanu', 'malaka', 'mbay', 'tambolaka'],
  'Sulawesi Utara': ['sulut', 'sulawesi utara', 'manado', 'bitung', 'tomohon', 'kotamobagu', 'minahasa', 'sangihe', 'talaud', 'bolaang mongondow', 'tondano', 'airmadidi', 'amurang'],
  'Gorontalo': ['gorontalo', 'boalemo', 'pohuwato', 'bone bolango', 'limboto', 'marisa'],
  'Sulawesi Tengah': ['sulteng', 'sulawesi tengah', 'palu', 'poso', 'luwuk', 'banggai', 'toli toli', 'tolitoli', 'donggala', 'morowali', 'parigi', 'parigi moutong', 'sigi', 'buol', 'ampana', 'kolonodale', 'bungku'],
  'Sulawesi Barat': ['sulbar', 'sulawesi barat', 'mamuju', 'majene', 'polewali', 'polewali mandar', 'polman', 'mamasa', 'pasangkayu', 'mamuju tengah'],
  'Sulawesi Selatan': ['sulsel', 'sulawesi selatan', 'makassar', 'makasar', 'gowa', 'sungguminasa', 'maros', 'pangkep', 'pangkajene', 'barru', 'parepare', 'pare pare', 'bone', 'watampone', 'sinjai', 'bulukumba', 'bantaeng', 'jeneponto', 'takalar', 'selayar', 'wajo', 'sengkang', 'soppeng', 'watansoppeng', 'sidrap', 'sidenreng rappang', 'pinrang', 'enrekang', 'luwu', 'luwu utara', 'luwu timur', 'palopo', 'toraja', 'tana toraja', 'toraja utara', 'rantepao', 'makale', 'masamba', 'malili', 'sorowako'],
  'Sulawesi Tenggara': ['sultra', 'sulawesi tenggara', 'kendari', 'baubau', 'bau bau', 'kolaka', 'konawe', 'muna', 'raha', 'buton', 'wakatobi', 'bombana', 'unaaha', 'wangi wangi'],
  'Maluku': ['maluku', 'ambon', 'tual', 'seram bagian barat', 'seram bagian timur', 'maluku tengah', 'maluku tenggara', 'kepulauan tanimbar', 'saumlaki', 'masohi', 'namlea', 'pulau buru', 'kepulauan aru', 'dobo', 'piru', 'langgur'],
  'Maluku Utara': ['malut', 'maluku utara', 'ternate', 'tidore', 'sofifi', 'halmahera', 'morotai', 'tobelo', 'sanana', 'labuha', 'weda', 'jailolo'],
  'Papua': ['papua', 'jayapura', 'sentani', 'keerom', 'biak', 'biak numfor', 'sarmi', 'waropen', 'yapen', 'kepulauan yapen', 'serui', 'supiori', 'mamberamo raya', 'abepura'],
  'Papua Barat': ['papua barat', 'pabar', 'manokwari', 'fakfak', 'fak fak', 'kaimana', 'teluk bintuni', 'bintuni', 'teluk wondama', 'pegunungan arfak', 'manokwari selatan'],
  'Papua Barat Daya': ['papua barat daya', 'sorong', 'sorong selatan', 'raja ampat', 'waisai', 'tambrauw', 'maybrat', 'teminabuan'],
  'Papua Tengah': ['papua tengah', 'nabire', 'timika', 'mimika', 'paniai', 'enarotali', 'puncak jaya', 'mulia', 'dogiyai', 'deiyai', 'intan jaya', 'sugapa', 'kabupaten puncak'],
  'Papua Pegunungan': ['papua pegunungan', 'wamena', 'jayawijaya', 'lanny jaya', 'tolikara', 'yahukimo', 'dekai', 'nduga', 'yalimo', 'pegunungan bintang', 'oksibil', 'mamberamo tengah'],
  'Papua Selatan': ['papua selatan', 'merauke', 'boven digoel', 'tanah merah', 'mappi', 'asmat', 'agats'],
};

// Nama pulau/wilayah umum yang hanya menentukan regional (provinsi tak pasti).
// Catatan: "jawa" sengaja TIDAK dimasukkan karena Jawa terbelah dua regional.
const ISLAND_KEYWORDS = {
  sumatra: { region: 'barat', label: 'Sumatera' },
  sumatera: { region: 'barat', label: 'Sumatera' },
  kalimantan: { region: 'barat', label: 'Kalimantan' },
  borneo: { region: 'barat', label: 'Kalimantan' },
  sulawesi: { region: 'timur', label: 'Sulawesi' },
  celebes: { region: 'timur', label: 'Sulawesi' },
  'nusa tenggara': { region: 'timur', label: 'Nusa Tenggara' },
  'indonesia timur': { region: 'timur', label: 'Indonesia Timur' },
  'indonesia barat': { region: 'barat', label: 'Indonesia Barat' },
};

function normalize(text) {
  return ' ' + String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';
}

// Daftar kata kunci terurut dari yang terpanjang -> frasa spesifik menang
// (mis. "jakarta selatan" sebelum "jakarta", "kepulauan riau" sebelum "riau").
const KEYWORDS = (() => {
  const list = [];
  for (const [province, words] of Object.entries(PROVINCE_KEYWORDS)) {
    for (const w of words) list.push({ key: normalize(w).trim(), province, region: PROVINCE_REGION[province] });
  }
  for (const [w, v] of Object.entries(ISLAND_KEYWORDS)) {
    list.push({ key: normalize(w).trim(), province: null, region: v.region, label: v.label });
  }
  return list.sort((a, b) => b.key.length - a.key.length);
})();

// Cocokkan teks dengan kamus. Return { province, region, matched } | null.
export function matchLocation(text) {
  const norm = normalize(text);
  if (norm.trim().length < 2) return null;
  for (const k of KEYWORDS) {
    if (norm.includes(` ${k.key} `)) {
      return { province: k.province, region: k.region, matched: k.label || k.key };
    }
  }
  return null;
}

// Pesan pertama customer kadang sudah menyebut lokasi ("halo saya dari Malang").
// Agar tidak salah tangkap kata umum, hanya cek frasa setelah kata penanda lokasi.
const LOCATION_CUE = /\b(?:dari|di|lokasi|domisili|daerah|wilayah|area|tinggal|posisi|alamat|kota|kab|kabupaten)\b\s+([a-z0-9 ]{2,60})/g;
export function detectFromIntro(text) {
  const norm = normalize(text).trim();
  let m;
  LOCATION_CUE.lastIndex = 0;
  while ((m = LOCATION_CUE.exec(norm)) !== null) {
    const fragment = m[1].split(' ').slice(0, 4).join(' ');
    const hit = matchLocation(fragment);
    if (hit) return hit;
  }
  return null;
}

// ── Fallback AI ─────────────────────────────────────────────────────────────
const PROVINCE_NAMES = Object.keys(PROVINCE_REGION);

export async function detectLocationAI(text) {
  if (!aiEnabled()) return null;
  const clean = String(text || '').slice(0, 200);
  if (clean.trim().length < 2) return null;
  try {
    const result = await generate('regional_city', {
      prompt:
        `Teks berikut adalah jawaban customer ketika ditanya "Kakak berlokasi di kota/kabupaten mana?":\n"""${clean}"""\n\n` +
        `Tentukan PROVINSI di Indonesia tempat lokasi tersebut. Pilih HANYA salah satu dari daftar ini:\n${PROVINCE_NAMES.join(', ')}.\n` +
        'Jika teks bukan nama lokasi di Indonesia atau tidak bisa dipastikan, isi province dengan string kosong.\n' +
        'Balas HANYA JSON: {"province": "...", "city": "..."}',
      system: 'Kamu memetakan nama kota/kabupaten/kecamatan/daerah di Indonesia ke provinsinya. Jawab akurat, jangan menebak bila ragu.',
      json: true,
      maxTokens: 100,
      temperature: 0,
    });
    const parsed = parseJsonLoose(result.text) || {};
    const wanted = String(parsed.province || '').trim().toLowerCase();
    if (!wanted) return null;
    const province = PROVINCE_NAMES.find((p) => p.toLowerCase() === wanted);
    if (!province) return null;
    return { province, region: PROVINCE_REGION[province], matched: parsed.city || province, viaAI: true };
  } catch (err) {
    console.warn('[Regional] deteksi AI gagal:', err?.message || err);
    return null;
  }
}

// Jawaban yang terlalu umum untuk menentukan regional (Jawa terbelah dua).
// Tidak dilempar ke AI agar bot meminta nama kota yang lebih spesifik.
const TOO_GENERIC = new Set(['jawa', 'pulau jawa', 'di jawa', 'indonesia', 'jawa indonesia']);

// Kamus dulu, lalu AI.
export async function detectLocation(text, { useAI = true } = {}) {
  const hit = matchLocation(text);
  if (hit) return hit;
  if (!useAI) return null;
  if (TOO_GENERIC.has(normalize(text).trim())) return null;
  return detectLocationAI(text);
}
