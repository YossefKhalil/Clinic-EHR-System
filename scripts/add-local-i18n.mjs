// Add the local-engine translation keys to both locale files.
//
// The two files must define exactly the same key set, so the keys are
// written from one table per language and both files are rewritten from it.
//
// Run: node scripts/add-local-i18n.mjs
import fs from 'node:fs';

const EN = {
    'aiSettings.engineLabel': 'AI import engine',
    'aiSettings.engine.off': 'Off',
    'aiSettings.engine.cloud': 'Cloud',
    'aiSettings.engine.local': 'This computer',
    'aiSettings.subtitleOff': 'AI Import is off.',
    'aiSettings.subtitleLocal': 'Runs in this browser, nothing leaves this computer.',
    'aiSettings.offNote': 'AI Import is off. Pick Cloud or This computer to enable it.',
    'aiSettings.saveLocal': 'Save local settings',
    'aiSettings.engineMismatch': 'The engine changed since this import was created. Start a new import.',
    'aiSettings.consent.title': 'Enable Cloud AI, data leaves this clinic',
    'aiSettings.consent.body': 'Cloud mode sends patient photos and extracted text to third-party AI providers over the internet.',
    'aiSettings.consent.acceptLabel': 'I accept the risk, send clinic data to cloud providers.',
    'aiSettings.consent.accept': 'Accept and enable',
    'aiSettings.consent.cancel': 'Cancel',
    'aiSettings.consent.required': "Cloud mode needs the clinic's consent before it can be switched on.",
    'aiSettings.consent.resetDone': 'The cloud consent was withdrawn. The next switch asks again.',
    'aiSettings.local.resetConsent': 'Reset cloud consent',
    'aiSettings.local.disabledHint': 'The local engine is not enabled on this deployment.',
    'aiSettings.local.readiness': 'Device readiness',
    'aiSettings.local.chip.webgpu': 'WebGPU',
    'aiSettings.local.chip.threads': ':count threads',
    'aiSettings.local.chip.memory': ':count GB+ RAM (reported)',
    'aiSettings.local.chip.storage': ':size storage free',
    'aiSettings.local.layout': 'Model layout',
    'aiSettings.local.layoutSingle': 'One multimodal model',
    'aiSettings.local.layoutSplit': 'Two models, text and vision',
    'aiSettings.local.layoutSingleHint': 'One model handles photos and extraction.',
    'aiSettings.local.layoutSplitHint': 'The vision model reads the photos; the text model extracts the records.',
    'aiSettings.local.multimodalTitle': 'Multimodal model',
    'aiSettings.local.splitTitle': 'Two models, text and vision',
    'aiSettings.local.modelFile': 'Model file (.gguf / .onnx)',
    'aiSettings.local.noFile': 'No file, click Browse',
    'aiSettings.local.browse': 'Browse',
    'aiSettings.local.remove': 'Remove',
    'aiSettings.local.textBadge': 'Text, extraction',
    'aiSettings.local.visionBadge': 'Vision, OCR',
    'aiSettings.local.textModel': 'Text model (.gguf)',
    'aiSettings.local.visionModel': 'Vision model (.onnx)',
    'aiSettings.local.supportFiles': 'Support files (tokenizer.json, config.json)',
    'aiSettings.local.supportPlaceholder': 'Folder with tokenizer.json and config.json',
    'aiSettings.local.browseFolder': 'Browse folder',
    'aiSettings.local.supportMissing': 'These files are still missing: :files',
    'aiSettings.local.visionGguFNote': 'A GGUF vision model is not supported in the two-model layout.',
    'aiSettings.local.runtimeTitle': 'Runtime',
    'aiSettings.local.lease': 'Chunk lease (s)',
    'aiSettings.local.heartbeat': 'Heartbeat (s)',
    'aiSettings.local.attempts': 'Max attempts',
    'aiSettings.local.parallel': 'Parallel chunks',
    'aiSettings.local.parallelHint': 'Above 1 multiplies the memory',
    'aiSettings.local.modelConfig': 'Model config',
    'aiSettings.local.context': 'Context',
    'aiSettings.local.kvCache': 'KV cache type',
    'aiSettings.local.gpuLayers': 'GPU layers',
    'aiSettings.local.threads': 'Threads',
    'aiSettings.local.batch': 'Batch size',
    'aiSettings.local.maxOutput': 'Max output',
    'aiSettings.local.flashAttention': 'Flash attention',
    'aiSettings.local.allowThinking': 'Allow thinking',
    'aiSettings.local.chatTemplate': 'Chat template override',
    'aiSettings.local.chatTemplateAuto': 'auto, from the model',
    'aiSettings.local.limitsNote': 'The row, file and chunk limits live in the import limits, shared with the cloud engine.',
    'aiSettings.local.statusNone': 'Not configured',
    'aiSettings.local.statusNotVerified': 'Not verified',
    'aiSettings.local.statusReady': 'Ready',
    'aiSettings.local.statusError': 'Error',
    'aiSettings.local.sha256': 'SHA-256 :hash',
    'aiSettings.local.modelAccepted': 'The model was checked and can be used.',
    'aiSettings.local.modelRejected': 'The model was refused: :detail',
    'aiSettings.local.modelMissing': 'Pick a model file before switching the local engine on.',
    'aiSettings.local.pickFailed': 'The file could not be read.',
    'aiSettings.local.folderUnsupported': 'This browser cannot open a folder. Pick the files one by one.',
    'aiSettings.local.supportAccepted': 'The support files were read.',
    'importAgent.progress.local.loading_model': 'Loading the model on this computer',
    'importAgent.progress.local.reading_photos': 'Reading the photos',
    'importAgent.progress.local.extracting': 'Extracting the records',
    'importAgent.wizard.localEngine': 'This computer (private)',
    'importAgent.wizard.cloudEngine': 'Cloud',
    'importAgent.wizard.localEngineHint': 'The model runs in this browser. Nothing leaves this computer.',
    'importAgent.wizard.cloudEngineHint': 'The data is sent to the AI provider the clinic configured.',
    'importAgent.wizard.localNoModel': 'No model is set up on this computer. The clinic chooses one in the AI settings.',
    'importAgent.error.NO_MODEL_PROFILE': 'No local model is set up on this computer.',
    'importAgent.error.LOCAL_MODE_DISABLED': 'The local engine is not enabled on this deployment.',
    'importAgent.error.ENGINE_MISMATCH': 'The engine changed since this import was created. Start a new import.',
    'importAgent.error.LOCAL_MODEL_NOT_CONFIGURED': 'No local model was set up for this import.',
};

const AR = {
    'aiSettings.engineLabel': 'محرك الاستيراد بالذكاء الاصطناعي',
    'aiSettings.engine.off': 'مغلق',
    'aiSettings.engine.cloud': 'السحابة',
    'aiSettings.engine.local': 'هذا الجهاز',
    'aiSettings.subtitleOff': 'الاستيراد بالذكاء الاصطناعي مغلق.',
    'aiSettings.subtitleLocal': 'يعمل داخل هذا المتصفح، ولا تغادر البيانات هذا الجهاز.',
    'aiSettings.offNote': 'الاستيراد بالذكاء الاصطناعي مغلق. اختر السحابة أو هذا الجهاز لتفعيله.',
    'aiSettings.saveLocal': 'حفظ إعدادات الجهاز',
    'aiSettings.engineMismatch': 'تغير المحرك بعد إنشاء هذا الاستيراد. ابدأ استيرادًا جديدًا.',
    'aiSettings.consent.title': 'تفعيل الذكاء الاصطناعي في السحابة، البيانات تغادر العيادة',
    'aiSettings.consent.body': 'وضع السحابة يرسل صور المرضى والنص المستخرج إلى مزودي ذكاء اصطناعي خارجيين عبر الإنترنت.',
    'aiSettings.consent.acceptLabel': 'أقبل المخاطرة، وأرسل بيانات العيادة إلى مزودي السحابة.',
    'aiSettings.consent.accept': 'أقبل وأفعل',
    'aiSettings.consent.cancel': 'إلغاء',
    'aiSettings.consent.required': 'وضع السحابة يحتاج موافقة العيادة قبل تفعيله.',
    'aiSettings.consent.resetDone': 'تم سحب الموافقة على السحابة. المحاولة التالية تستأذن مرة أخرى.',
    'aiSettings.local.resetConsent': 'إعادة ضبط موافقة السحابة',
    'aiSettings.local.disabledHint': 'محرك الجهاز المحلي غير مفعّل في هذا التثبيت.',
    'aiSettings.local.readiness': 'جاهزية الجهاز',
    'aiSettings.local.chip.webgpu': 'WebGPU',
    'aiSettings.local.chip.threads': ':count خيط',
    'aiSettings.local.chip.memory': ':count جيجابايت+ ذاكرة (مُبلَّغ عنه)',
    'aiSettings.local.chip.storage': ':size مساحة خالية',
    'aiSettings.local.layout': 'ترتيب النماذج',
    'aiSettings.local.layoutSingle': 'نموذج واحد متعدد الوسائط',
    'aiSettings.local.layoutSplit': 'نموذجان: نص ورؤية',
    'aiSettings.local.layoutSingleHint': 'نموذج واحد يقرأ الصور ويستخرج البيانات.',
    'aiSettings.local.layoutSplitHint': 'نموذج الرؤية يقرأ الصور، ونموذج النص يستخرج السجلات.',
    'aiSettings.local.multimodalTitle': 'النموذج متعدد الوسائط',
    'aiSettings.local.splitTitle': 'نموذجان: نص ورؤية',
    'aiSettings.local.modelFile': 'ملف النموذج (.gguf / .onnx)',
    'aiSettings.local.noFile': 'لا يوجد ملف، اضغط تصفح',
    'aiSettings.local.browse': 'تصفح',
    'aiSettings.local.remove': 'إزالة',
    'aiSettings.local.textBadge': 'نص، استخراج',
    'aiSettings.local.visionBadge': 'رؤية، قراءة الصور',
    'aiSettings.local.textModel': 'نموذج النص (.gguf)',
    'aiSettings.local.visionModel': 'نموذج الرؤية (.onnx)',
    'aiSettings.local.supportFiles': 'الملفات المساعدة (tokenizer.json، config.json)',
    'aiSettings.local.supportPlaceholder': 'مجلد يحوي tokenizer.json و config.json',
    'aiSettings.local.browseFolder': 'تصفح المجلد',
    'aiSettings.local.supportMissing': 'هذه الملفات ناقصة: :files',
    'aiSettings.local.visionGguFNote': 'نموذج الرؤية بصيغة GGUF غير مدعوم في تخطيط النموذجين.',
    'aiSettings.local.runtimeTitle': 'التشغيل',
    'aiSettings.local.lease': 'مدة حجز الجزء (ثانية)',
    'aiSettings.local.heartbeat': 'نبض الاتصال (ثانية)',
    'aiSettings.local.attempts': 'أقصى عدد محاولات',
    'aiSettings.local.parallel': 'أجزاء متوازية',
    'aiSettings.local.parallelHint': 'أكثر من واحد يضاعف الذاكرة',
    'aiSettings.local.modelConfig': 'إعدادات النموذج',
    'aiSettings.local.context': 'حجم السياق',
    'aiSettings.local.kvCache': 'نوع ذاكرة KV',
    'aiSettings.local.gpuLayers': 'طبقات المعالج',
    'aiSettings.local.threads': 'الخيوط',
    'aiSettings.local.batch': 'حجم الدفعة',
    'aiSettings.local.maxOutput': 'أقصى مخرجات',
    'aiSettings.local.flashAttention': 'Flash attention',
    'aiSettings.local.allowThinking': 'السماح بالتفكير',
    'aiSettings.local.chatTemplate': 'قالب المحادثة',
    'aiSettings.local.chatTemplateAuto': 'تلقائي، من النموذج',
    'aiSettings.local.limitsNote': 'حدود الصفوف والملفات والأجزاء موجودة في حدود الاستيراد، مشتركة مع محرك السحابة.',
    'aiSettings.local.statusNone': 'غير محدد',
    'aiSettings.local.statusNotVerified': 'لم يتم التحقق',
    'aiSettings.local.statusReady': 'جاهز',
    'aiSettings.local.statusError': 'خطأ',
    'aiSettings.local.sha256': 'SHA-256 :hash',
    'aiSettings.local.modelAccepted': 'تم فحص النموذج ويمكن استخدامه.',
    'aiSettings.local.modelRejected': 'تم رفض النموذج: :detail',
    'aiSettings.local.modelMissing': 'اختر ملف نموذج قبل تفعيل محرك الجهاز المحلي.',
    'aiSettings.local.pickFailed': 'تعذّرت قراءة الملف.',
    'aiSettings.local.folderUnsupported': 'هذا المتصفح لا يستطيع فتح مجلد. اختر الملفات واحدًا واحدًا.',
    'aiSettings.local.supportAccepted': 'تمت قراءة الملفات المساعدة.',
    'importAgent.progress.local.loading_model': 'تحميل النموذج على هذا الجهاز',
    'importAgent.progress.local.reading_photos': 'قراءة الصور',
    'importAgent.progress.local.extracting': 'استخراج السجلات',
    'importAgent.wizard.localEngine': 'هذا الجهاز (خاص)',
    'importAgent.wizard.cloudEngine': 'السحابة',
    'importAgent.wizard.localEngineHint': 'النموذج يعمل داخل هذا المتصفح، ولا تغادر البيانات هذا الجهاز.',
    'importAgent.wizard.cloudEngineHint': 'تُرسل البيانات إلى مزود الذكاء الاصطناعي الذي ضبطته العيادة.',
    'importAgent.wizard.localNoModel': 'لا يوجد نموذج مُعد على هذا الجهاز. تختار العيادة النموذج من إعدادات الذكاء الاصطناعي.',
    'importAgent.error.NO_MODEL_PROFILE': 'لا يوجد نموذج محلي مُعد على هذا الجهاز.',
    'importAgent.error.LOCAL_MODE_DISABLED': 'محرك الجهاز المحلي غير مفعّل في هذا التثبيت.',
    'importAgent.error.ENGINE_MISMATCH': 'تغير المحرك بعد إنشاء هذا الاستيراد. ابدأ استيرادًا جديدًا.',
    'importAgent.error.LOCAL_MODEL_NOT_CONFIGURED': 'لم يتم إعداد نموذج محلي لهذا الاستيراد.',
};

const TABLES = { 'src/locales/en.json': EN, 'src/locales/ar.json': AR };

// The new keys go right after the last existing aiSettings key, so the file
// keeps its grouping.
function insertAfterLastPrefix(text, prefix, entries) {
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed);
    let anchor = -1;
    for (let i = 0; i < keys.length; i += 1) {
        if (keys[i].startsWith(prefix)) anchor = i;
    }
    const out = {};
    for (const key of keys) {
        out[key] = parsed[key];
        if (key === keys[anchor]) {
            for (const [name, value] of Object.entries(entries)) {
                if (name in parsed) continue;
                out[name] = value;
            }
        }
    }
    return `${JSON.stringify(out, null, 2)}\n`;
}

for (const [file, entries] of Object.entries(TABLES)) {
    const text = fs.readFileSync(file, 'utf8');
    const updated = insertAfterLastPrefix(text, 'aiSettings.', entries);
    fs.writeFileSync(file, updated, 'utf8');
    console.log(`${file}: ${Object.keys(JSON.parse(updated)).length} keys`);
}
