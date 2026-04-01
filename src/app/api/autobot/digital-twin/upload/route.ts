import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type DigitalTwinAsset,
  type DigitalTwinAssetKind,
} from "@/lib/autobot-user-settings";
import {
  uploadDigitalTwinAsset,
  FileSizeError,
  InvalidMimeTypeError,
  StorageError,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

const VALID_KINDS: DigitalTwinAssetKind[] = [
  "host-video",
  "reference-portrait",
  "idle-video",
  "background-plate",
];

function generateId() {
  return `dt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request body must be multipart/form-data" }, { status: 400 });
  }

  const kind = formData.get("kind");
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as DigitalTwinAssetKind)) {
    return NextResponse.json({ error: `kind must be one of: ${VALID_KINDS.join(", ")}` }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const uploaded = await uploadDigitalTwinAsset(buffer, file.name, file.type, session.user.id);

    const asset: DigitalTwinAsset = {
      id: generateId(),
      kind: kind as DigitalTwinAssetKind,
      fileName: file.name,
      key: uploaded.key,
      url: uploaded.url,
      bucket: uploaded.bucket,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
      uploadedAt: new Date(uploaded.timestamp).toISOString(),
    };

    const existing = await getAutobotUserSettings(session.user.id);
    const nextAssets = [asset, ...existing.digitalTwin.assets].slice(0, 32);
    const settings = await saveAutobotUserSettings(session.user.id, {
      digitalTwin: {
        ...existing.digitalTwin,
        assets: nextAssets,
        updatedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ asset, digitalTwin: settings.digitalTwin });
  } catch (error) {
    if (error instanceof FileSizeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidMimeTypeError) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    if (error instanceof StorageError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ error: "Digital twin upload failed" }, { status: 500 });
  }
}
