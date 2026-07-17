import crypto from "node:crypto";

type CloudinaryConfig = {
    cloudName: string;
    apiKey: string;
    uploadPreset: string;
    apiSecret: string;
};

type CloudinaryUploadResult = {
    secure_url: string;
    public_id: string;
    bytes: number;
    original_filename?: string;
};

function getCloudinaryConfig(): CloudinaryConfig {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !uploadPreset || !apiSecret) {
        throw new Error("Missing Cloudinary environment variables");
    }

    return { cloudName, apiKey, uploadPreset, apiSecret };
}

function buildSignature(params: Record<string, string>, apiSecret: string) {
    const payload = Object.entries(params)
        .filter(([, value]) => value !== "")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");

    return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export async function uploadCompanyPdf(file: File, folder = "stackmemo/company-pdfs") {
    const { cloudName, apiKey, uploadPreset } = getCloudinaryConfig();
    const buffer = Buffer.from(await file.arrayBuffer());
    const formData = new FormData();

    formData.append("file", new Blob([buffer], { type: "application/pdf" }), file.name);
    formData.append("folder", folder);
    formData.append("api_key", apiKey);
    formData.append("upload_preset", uploadPreset);

    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloudinary upload failed: ${text}`);
    }

    const data = (await response.json()) as CloudinaryUploadResult;

    return {
        url: data.secure_url,
        publicId: data.public_id,
        bytes: data.bytes,
        originalFilename: data.original_filename ?? file.name,
    };
}

export async function deleteCompanyPdf(publicId: string) {
    const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = buildSignature({ public_id: publicId, timestamp }, apiSecret);

    const body = new URLSearchParams({
        public_id: publicId,
        timestamp,
        api_key: apiKey,
        signature,
    });

    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/destroy`, {
        method: "POST",
        body,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cloudinary delete failed: ${text}`);
    }
}