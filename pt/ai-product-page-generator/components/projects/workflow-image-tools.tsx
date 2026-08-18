"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  arraySwap,
  rectSortingStrategy,
  rectSwappingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ImagePlus,
  Languages,
  Loader2,
  MoreVertical,
  PencilLine,
  Plus,
  Star,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDismissOnOutside } from "@/components/shared/use-dismiss-on-outside";

export type ManagedWorkflowImage = {
  id: string;
  name: string;
  url: string;
  label: string;
  source: "crawler" | "upload" | "generated" | "edited";
};

export type WorkflowImageDialogMode = "manage" | "main" | "other";
export type WorkflowOcrEngine = "web" | "doubao";
export const WORKFLOW_IMAGE_LIMIT = 30;

export function workflowImagesToOzonPayload(images: ManagedWorkflowImage[]) {
  const uploadImages = images.slice(0, WORKFLOW_IMAGE_LIMIT);
  return {
    primary_image: uploadImages[0]?.url || "",
    images: uploadImages.slice(1).map((image) => image.url),
  };
}

type WorkflowImageFieldProps = {
  images: ManagedWorkflowImage[];
  generating?: boolean;
  ocrReady?: boolean;
  selectedImageIds?: string[];
  onOpen: (mode: WorkflowImageDialogMode) => void;
  onDelete: (imageId: string) => void;
  onDeleteSelected?: () => void;
  onGenerate: (imageId: string) => void | Promise<void>;
  onReorder: (images: ManagedWorkflowImage[]) => void;
  onToggleSelect?: (imageId: string) => void;
  onTranslate: (imageId: string) => void;
};

type WorkflowImageDialogProps = {
  mode: WorkflowImageDialogMode | null;
  images: ManagedWorkflowImage[];
  selectedImageIds?: string[];
  initialImageId?: string;
  imageModelLabel: string;
  generating: boolean;
  ocrReady: boolean;
  ocrEndpoint: string;
  onClose: () => void;
  onAddFiles: (files: File[]) => void | Promise<void>;
  onDelete: (imageId: string) => void;
  onSelectionChange?: (selectedImageIds: string[]) => void;
  onReorder: (images: ManagedWorkflowImage[]) => void;
  onSetPrimary: (imageId: string) => void;
  onGenerate: (imageId: string) => void | Promise<void>;
  onBatchTranslate?: (images: ManagedWorkflowImage[], targetLanguage: string) => Promise<void>;
  onApplyEditedImage: (imageId: string, dataUrl: string, name: string) => void;
};

function imageSrc(url: string) {
  if (/^https?:\/\//i.test(url)) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function imageDataUrl(url: string) {
  return new Promise<string>(async (resolve, reject) => {
    try {
      const response = await fetch(imageSrc(url));
      if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(await response.blob());
    } catch (error) {
      reject(error);
    }
  });
}

function SortableFieldImageCard(props: {
  image: ManagedWorkflowImage;
  index: number;
  generating?: boolean;
  ocrReady?: boolean;
  selected?: boolean;
  onDelete: () => void;
  onGenerate: () => void | Promise<void>;
  onToggleSelect?: () => void;
  onTranslate: () => void;
}) {
  const sortable = useSortable({ id: props.image.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(menuRef, menuOpen, () => setMenuOpen(false));
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const primary = props.index === 0;
  const selected = !primary && props.selected;

  return (
    <div
      ref={sortable.setNodeRef}
      {...sortable.attributes}
      {...sortable.listeners}
      style={style}
      role="button"
      tabIndex={0}
      aria-pressed={primary ? undefined : selected}
      className={`group relative aspect-square min-w-0 cursor-grab overflow-hidden rounded-lg border bg-slate-50 text-left shadow-sm outline-none transition active:cursor-grabbing dark:bg-white/[0.04] ${
        sortable.isDragging
          ? "z-10 border-sky-400 opacity-80 shadow-lg ring-2 ring-sky-200"
          : selected
            ? "border-[3px] border-blue-700 shadow-[0_0_0_4px_rgb(37_99_235_/_0.32)] ring-2 ring-blue-500/30 dark:border-blue-400 dark:shadow-[0_0_0_4px_rgb(96_165_250_/_0.32)] dark:ring-blue-400/30"
          : props.index === 0
            ? "border-emerald-400 ring-2 ring-emerald-100 dark:border-emerald-500/70 dark:ring-emerald-500/15"
            : "border-slate-200 hover:border-sky-300 dark:border-white/10"
      }`}
      title={primary
        ? "Ozon 主图固定进入加工；按住图片可调整顺序"
        : `第 ${props.index + 1} 张，点击选择/取消选择，按住图片拖动调整顺序`}
      aria-label={primary
        ? `主图 ${props.image.name} 固定进入加工，也可按住拖动排序`
        : `${selected ? "取消选择" : "选择"} ${props.image.name}，也可按住拖动排序`}
      onClick={() => {
        if (!primary) props.onToggleSelect?.();
      }}
      onKeyDown={(event) => {
        if (!primary && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          props.onToggleSelect?.();
        }
      }}
    >
      <img
        src={imageSrc(props.image.url)}
        alt={props.image.name}
        draggable={false}
        className="h-full w-full select-none object-cover transition duration-200 group-hover:scale-[1.02]"
      />
      {!primary ? (
        <button
          type="button"
          aria-label={`${selected ? "取消选择图片" : "选择图片"} ${props.image.name}`}
          title={selected ? "取消选择" : "选择此图"}
          className={`absolute left-2 top-2 z-20 grid h-8 w-8 place-items-center rounded-full shadow-lg ring-2 transition ${
            selected
              ? "bg-blue-700 text-white ring-white dark:bg-blue-500 dark:ring-slate-950"
              : "bg-white/95 text-slate-400 ring-white/80 hover:bg-blue-50 hover:text-blue-700 dark:bg-slate-900/95 dark:text-slate-400 dark:ring-slate-950 dark:hover:text-blue-300"
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleSelect?.();
          }}
        >
          <Check className={`h-5 w-5 stroke-[3] ${selected ? "opacity-100" : "opacity-55"}`} />
        </button>
      ) : (
        <span className="absolute left-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1.5 text-[10px] font-semibold text-white shadow-lg ring-2 ring-white dark:ring-slate-950">
          <Star className="h-3.5 w-3.5 fill-current" />
          固定保留
        </span>
      )}
      <div ref={menuRef} className="absolute right-2 top-2 z-20">
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-full bg-white/95 text-slate-700 shadow transition hover:bg-white hover:text-slate-950 dark:bg-slate-900/95 dark:text-slate-200"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="图片操作"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-10 z-30 w-32 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-xl dark:border-white/10 dark:bg-slate-950"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {props.index === 0 ? (
              <button
                type="button"
                role="menuitem"
                disabled={props.generating}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/[0.06]"
                onClick={() => {
                  setMenuOpen(false);
                  void props.onGenerate();
                }}
              >
                {props.generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                主图生图
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={!props.ocrReady}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-white/[0.06]"
                onClick={() => {
                  setMenuOpen(false);
                  props.onTranslate();
                }}
              >
                <Languages className="h-3.5 w-3.5" />
                翻译此图
              </button>
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="absolute bottom-9 right-2 z-20 grid h-8 w-8 place-items-center rounded-full bg-white/95 text-rose-600 shadow transition hover:bg-rose-50 dark:bg-slate-900/95 dark:text-rose-300"
        title="删除图片"
        aria-label={`删除 ${props.image.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.onDelete();
        }}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <span className="absolute inset-x-0 bottom-0 flex min-w-0 items-center justify-between gap-2 bg-slate-950/75 px-2 py-1.5 text-[10px] text-white">
        <span className="truncate">{props.image.name}</span>
        <span className="inline-flex shrink-0 items-center gap-1 font-semibold">
          {props.index === 0 ? (
            <>
              <Star className="h-3 w-3 fill-current" />
              主图
            </>
          ) : (
            String(props.index + 1).padStart(2, "0")
          )}
        </span>
      </span>
    </div>
  );
}

export function WorkflowImageField(props: WorkflowImageFieldProps) {
  const emptyCount = Math.max(3 - props.images.length, 0);
  const selectedIds = new Set(props.selectedImageIds ?? []);
  const selectedOtherCount = props.images
    .slice(1)
    .filter((image) => selectedIds.has(image.id)).length;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const overId = event.over?.id;
    if (!overId || event.active.id === overId) return;
    const oldIndex = props.images.findIndex((image) => image.id === event.active.id);
    const newIndex = props.images.findIndex((image) => image.id === overId);
    if (oldIndex < 0 || newIndex < 0) return;
    props.onReorder(arrayMove(props.images, oldIndex, newIndex));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:bg-white/[0.04]">
        <span>
          {selectedOtherCount
            ? `主图固定进入加工；已选择 ${selectedOtherCount} 张附图，这些附图将进入加工和翻译。`
            : "主图固定进入加工；其余图片只有勾选后才会进入加工和翻译。"}
        </span>
        {selectedOtherCount ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-lg text-rose-600 hover:text-rose-700"
            onClick={props.onDeleteSelected}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除选中
          </Button>
        ) : null}
      </div>
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_176px]">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SortableContext items={props.images.map((image) => image.id)} strategy={rectSortingStrategy}>
            {props.images.map((image, index) => (
              <SortableFieldImageCard
                key={image.id}
                image={image}
                index={index}
                generating={props.generating}
                ocrReady={props.ocrReady}
                selected={selectedIds.has(image.id)}
                onDelete={() => props.onDelete(image.id)}
                onGenerate={() => props.onGenerate(image.id)}
                onToggleSelect={() => props.onToggleSelect?.(image.id)}
                onTranslate={() => props.onTranslate(image.id)}
              />
            ))}
          </SortableContext>

          {Array.from({ length: emptyCount }).map((_, index) => (
            <div
              key={`empty-${index}`}
              className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-[11px] text-slate-400 dark:border-white/10 dark:bg-white/[0.04]"
            >
              待采集
            </div>
          ))}

          <button
            type="button"
            onClick={() => props.onOpen("manage")}
            className="group flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white text-slate-500 transition hover:border-sky-400 hover:bg-sky-50 hover:text-sky-700 dark:border-white/15 dark:bg-black/20 dark:hover:border-sky-500/50 dark:hover:bg-sky-500/10 dark:hover:text-sky-200"
            title="添加或管理图片"
          >
            <span className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-slate-50 transition group-hover:border-sky-200 group-hover:bg-white dark:border-white/10 dark:bg-white/[0.06]">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-medium">添加图片</span>
          </button>
        </div>
      </DndContext>

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
        <Button type="button" variant="outline" className="h-auto min-h-12 gap-2 rounded-lg" onClick={() => props.onOpen("main")}>
          <Wand2 className="h-4 w-4" />
          主图生图
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!selectedOtherCount}
          className="h-auto min-h-12 gap-2 rounded-lg"
          onClick={() => props.onOpen("other")}
        >
          <PencilLine className="h-4 w-4" />
          {selectedOtherCount ? `翻译选中图片 (${selectedOtherCount})` : "先选择翻译图片"}
        </Button>
      </div>
    </div>
    </div>
  );
}

function SortableEditorImageTile(props: {
  image: ManagedWorkflowImage;
  index: number;
  selected?: boolean;
  onToggleSelect?: () => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({ id: props.image.id });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const primary = props.index === 0;
  const selected = !primary && props.selected;

  return (
    <div
      ref={sortable.setNodeRef}
      {...sortable.attributes}
      {...sortable.listeners}
      style={style}
      role="button"
      tabIndex={0}
      aria-pressed={primary ? undefined : selected}
      aria-label={
        primary
          ? `主图 ${props.image.name}，固定进入主图处理`
          : `${selected ? "取消待翻译选择" : "选择为待翻译图片"} ${props.image.name}`
      }
      title={
        primary
          ? "第一张为主图，拖动可调整顺序"
          : "点击选择或取消待翻译；拖动可调整顺序"
      }
      onClick={() => {
        if (!primary) props.onToggleSelect?.();
      }}
      onKeyDown={(event) => {
        if (!primary && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          props.onToggleSelect?.();
        }
      }}
      className={`group relative min-h-0 cursor-grab overflow-hidden rounded-lg border bg-slate-100 shadow-sm outline-none transition active:cursor-grabbing dark:bg-slate-950 ${
        primary ? "col-span-2 row-span-2" : ""
      } ${
        sortable.isDragging
          ? "z-10 border-sky-400 opacity-75 shadow-lg ring-2 ring-sky-200"
          : selected
            ? "border-[4px] border-black shadow-[0_0_0_2px_rgb(0_0_0_/_0.16)] ring-2 ring-black/15 dark:border-white dark:shadow-[0_0_0_2px_rgb(255_255_255_/_0.18)] dark:ring-white/20"
          : primary
            ? "border-emerald-400 ring-2 ring-emerald-100 dark:border-emerald-500/70 dark:ring-emerald-500/15"
            : "border-slate-200 dark:border-white/10"
      }`}
    >
      <img
        src={imageSrc(props.image.url)}
        alt={props.image.name}
        draggable={false}
        className="h-full w-full select-none object-cover transition duration-200 group-hover:scale-[1.02]"
      />
      {primary ? (
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white shadow">
          <Star className="h-3 w-3 fill-current" />
          主图
        </span>
      ) : (
        <span className="absolute bottom-2 left-2 rounded-full bg-slate-950/70 px-2 py-1 text-[10px] font-semibold text-white">
          {String(props.index + 1).padStart(2, "0")}
        </span>
      )}
      {selected ? (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black px-2 py-1 text-[10px] font-semibold text-white shadow-lg dark:bg-white dark:text-black">
          <Check className="h-3 w-3 stroke-[3]" />
          待翻译
        </span>
      ) : null}
      <button
        type="button"
        onClick={props.onDelete}
        onPointerDown={(event) => event.stopPropagation()}
        className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-white/95 text-rose-600 shadow transition hover:bg-rose-50 dark:bg-slate-900/95"
        title="删除图片"
        aria-label={`删除 ${props.image.name}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-slate-950/60 px-2 py-1.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100">
        {props.image.name}
      </span>
    </div>
  );
}

function SelectableImageCard(props: {
  image: ManagedWorkflowImage;
  selected: boolean;
  primary: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`relative overflow-hidden rounded-lg border-2 bg-white text-left transition dark:bg-slate-950 ${
        props.selected
          ? "border-blue-700 shadow-[0_0_0_4px_rgb(37_99_235_/_0.38)] ring-2 ring-blue-500/25 dark:border-blue-400 dark:shadow-[0_0_0_4px_rgb(96_165_250_/_0.36)] dark:ring-blue-400/25"
          : "border-transparent ring-1 ring-slate-200 hover:ring-sky-300 dark:ring-white/10"
      }`}
    >
      <div className="relative aspect-square overflow-hidden bg-slate-100 dark:bg-black/30">
        <img src={imageSrc(props.image.url)} alt={props.image.name} className="h-full w-full object-cover" />
        {props.primary ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white">
            <Star className="h-3 w-3 fill-current" />
            主图
          </span>
        ) : null}
        {props.selected ? (
          <span className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-blue-700 text-white shadow-lg ring-2 ring-white dark:bg-blue-500 dark:ring-slate-950">
            <Check className="h-5 w-5 stroke-[3]" />
          </span>
        ) : null}
      </div>
      <div className="min-w-0 px-2 py-2">
        <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{props.image.name}</p>
        <p className="mt-0.5 truncate text-[10px] text-slate-400">{props.image.label}</p>
      </div>
    </button>
  );
}

export function WorkflowImageDialog(props: WorkflowImageDialogProps) {
  const [selectedImageId, setSelectedImageId] = useState("");
  const [ocrEngine, setOcrEngine] = useState<WorkflowOcrEngine>("doubao");
  const [targetLanguage, setTargetLanguage] = useState("ru");
  const [batchTranslating, setBatchTranslating] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [editorMessage, setEditorMessage] = useState("");
  const [manageSelectedImageIds, setManageSelectedImageIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLIFrameElement | null>(null);
  const manageOriginalImagesRef = useRef<ManagedWorkflowImage[] | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectableImages = props.images;
  const selectedImage = selectableImages.find((image) => image.id === selectedImageId) ?? selectableImages[0] ?? null;
  const editorOrigin = useMemo(() => {
    try {
      return new URL(props.ocrEndpoint || "http://127.0.0.1:8010").origin;
    } catch {
      return "http://127.0.0.1:8010";
    }
  }, [props.ocrEndpoint]);
  const editorUrl = `${editorOrigin}/?embedded=1`;

  useEffect(() => {
    if (props.mode === "manage" && manageOriginalImagesRef.current === null) {
      manageOriginalImagesRef.current = props.images.slice();
      setManageSelectedImageIds(
        (props.selectedImageIds ?? []).filter(
          (id) => id !== props.images[0]?.id && props.images.some((image) => image.id === id),
        ),
      );
    }
    if (!props.mode) {
      manageOriginalImagesRef.current = null;
    }
  }, [props.images, props.mode, props.selectedImageIds]);

  const cancelManageChanges = useCallback(() => {
    const originalImages = manageOriginalImagesRef.current;
    if (originalImages) {
      props.onReorder(originalImages);
    }
    manageOriginalImagesRef.current = null;
    props.onClose();
  }, [props.onClose, props.onReorder]);

  const saveManageChanges = useCallback(() => {
    const availableIds = new Set(props.images.slice(1).map((image) => image.id));
    props.onSelectionChange?.(
      manageSelectedImageIds.filter((id) => availableIds.has(id)),
    );
    manageOriginalImagesRef.current = null;
    props.onClose();
  }, [manageSelectedImageIds, props.images, props.onClose, props.onSelectionChange]);

  const closeCurrentDialog = useCallback(() => {
    if (props.mode === "manage") {
      cancelManageChanges();
      return;
    }
    props.onClose();
  }, [cancelManageChanges, props.mode, props.onClose]);

  useEffect(() => {
    if (!props.mode) return;
    const firstId = props.images[0]?.id || "";
    const preferredId =
      props.initialImageId && props.images.some((image) => image.id === props.initialImageId)
        ? props.initialImageId
        : "";
    setSelectedImageId((current) => {
      if (preferredId && preferredId !== current) return preferredId;
      return props.images.some((image) => image.id === current) ? current : firstId;
    });
  }, [props.images, props.initialImageId, props.mode]);

  useEffect(() => {
    if (!props.mode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCurrentDialog();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeCurrentDialog, props.mode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== editorOrigin) return;
      const payload = event.data as {
        type?: string;
        imageId?: string;
        dataUrl?: string;
        name?: string;
        message?: string;
      };
      if (payload.type === "image-workshop-ready") {
        setEditorReady(true);
      }
      if (payload.type === "image-workshop-status") {
        setEditorMessage(payload.message || "");
      }
      if (
        payload.type === "image-workshop-result" &&
        payload.imageId &&
        payload.dataUrl
      ) {
        props.onApplyEditedImage(
          payload.imageId,
          payload.dataUrl,
          payload.name || "edited-image.png",
        );
        setEditorMessage("修改结果已回填到工作流");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [editorOrigin, props.onApplyEditedImage]);

  useEffect(() => {
    if (props.mode !== "other" || !selectedImage || !editorReady) return;
    let cancelled = false;
    setEditorMessage("正在载入图片...");
    void imageDataUrl(selectedImage.url)
      .then((dataUrl) => {
        if (cancelled) return;
        editorRef.current?.contentWindow?.postMessage(
          {
            type: "image-workshop-load",
            image: {
              id: selectedImage.id,
              name: selectedImage.name,
              dataUrl,
            },
            engine: ocrEngine,
            targetLanguage,
          },
          editorOrigin,
        );
        setEditorMessage("图片已载入，可开始识别和修改");
      })
      .catch((error) => {
        if (!cancelled) {
          setEditorMessage(error instanceof Error ? error.message : "图片载入失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editorOrigin, editorReady, ocrEngine, props.mode, selectedImage, targetLanguage]);

  if (!props.mode) return null;

  function handleManageDragEnd(event: DragEndEvent) {
    const overId = event.over?.id;
    if (!overId || event.active.id === overId) return;
    const oldIndex = props.images.findIndex((image) => image.id === event.active.id);
    const newIndex = props.images.findIndex((image) => image.id === overId);
    if (oldIndex < 0 || newIndex < 0) return;
    props.onReorder(arraySwap(props.images, oldIndex, newIndex));
  }

  const manageSlots = Array.from(
    { length: WORKFLOW_IMAGE_LIMIT },
    (_, index) => props.images[index] ?? null,
  );

  const title =
    props.mode === "manage"
      ? "管理商品图片"
      : props.mode === "main"
        ? "主图调整"
        : "其他图片调整";
  const description =
    props.mode === "manage"
      ? "添加、删除或拖动图片调整上架顺序，第一张图片作为 Ozon 主图。"
      : props.mode === "main"
        ? "主图专用于 AI 生图或改图，不进入图片翻译流程。"
      : "左侧仅展示已选中的其他图片；一次处理当前蓝框图片。";

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeCurrentDialog();
      }}
    >
      <div
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950 ${
          props.mode === "manage" ? "max-w-7xl" : "max-w-6xl"
        }`}
      >
        {props.mode === "manage" ? (
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 dark:border-white/10 md:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-slate-950 dark:text-white">商品照片</h2>
                <Badge variant="outline">{Math.min(props.images.length, WORKFLOW_IMAGE_LIMIT)} / {WORKFLOW_IMAGE_LIMIT}</Badge>
              </div>
              <p className="mt-1 text-sm leading-5 text-slate-500 dark:text-slate-400">
                第一张图片作为 Ozon 主图；点击其他图片可多选待翻译图片，黑色框表示已选择。
              </p>
              <p className="mt-1 text-xs font-medium text-slate-700 dark:text-slate-300">
                已选择 {manageSelectedImageIds.length} 张待翻译图片
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  if (files.length) void props.onAddFiles(files);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="gap-2 rounded-lg border-sky-100 bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-800"
                disabled={props.images.length >= WORKFLOW_IMAGE_LIMIT}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
                添加图片
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3 dark:border-white/10 md:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-950 dark:text-white">{title}</h2>
                <Badge variant="outline">{props.images.length} 张</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
            </div>
            <button
              type="button"
              onClick={closeCurrentDialog}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {props.mode === "manage" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto bg-white p-4 dark:bg-slate-950 md:p-6">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleManageDragEnd}>
                <SortableContext
                  items={props.images.slice(0, WORKFLOW_IMAGE_LIMIT).map((image) => image.id)}
                  strategy={rectSwappingStrategy}
                >
                  <div className="grid auto-rows-[104px] grid-cols-3 gap-3 sm:auto-rows-[116px] sm:grid-cols-4 md:grid-cols-6 lg:auto-rows-[136px] lg:grid-cols-8">
                    {manageSlots.map((image, index) =>
                      image ? (
                        <SortableEditorImageTile
                          key={image.id}
                          image={image}
                          index={index}
                          selected={manageSelectedImageIds.includes(image.id)}
                          onToggleSelect={() =>
                            setManageSelectedImageIds((current) =>
                              current.includes(image.id)
                                ? current.filter((id) => id !== image.id)
                                : [...current, image.id],
                            )
                          }
                          onDelete={() => props.onDelete(image.id)}
                        />
                      ) : (
                        <div
                          key={`empty-slot-${index}`}
                          className={`rounded-lg bg-slate-50 ring-1 ring-inset ring-slate-100 dark:bg-white/[0.035] dark:ring-white/[0.04] ${
                            index === 0 ? "col-span-2 row-span-2" : ""
                          }`}
                          aria-label={`空图片位 ${index + 1}`}
                        />
                      ),
                    )}
                  </div>
                  </SortableContext>
                </DndContext>
            </div>
            <div className="flex shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-4 py-4 dark:border-white/10 dark:bg-slate-950 md:px-6">
              <Button type="button" className="min-w-24 rounded-lg" onClick={saveManageChanges}>
                保存
              </Button>
              <Button type="button" variant="outline" className="min-w-24 rounded-lg" onClick={cancelManageChanges}>
                取消
              </Button>
            </div>
          </>
        ) : null}

        {props.mode === "main" ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
              {props.images.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {props.images.map((image, index) => (
                    <SelectableImageCard
                      key={image.id}
                      image={image}
                      selected={selectedImage?.id === image.id}
                      primary={index === 0}
                      onSelect={() => setSelectedImageId(image.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500 dark:border-white/15">
                  请先在图片管理中添加图片
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03] md:flex-row md:items-center md:justify-between md:px-5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{selectedImage?.name || "未选择图片"}</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  图片模型：{props.imageModelLabel || "未配置"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2 rounded-lg"
                  disabled={!selectedImage}
                  onClick={() => selectedImage && props.onSetPrimary(selectedImage.id)}
                >
                  <Star className="h-4 w-4" />
                  设为主图
                </Button>
                <Button
                  type="button"
                  className="gap-2 rounded-lg"
                  disabled={!selectedImage || props.generating}
                  onClick={() => selectedImage && void props.onGenerate(selectedImage.id)}
                >
                  {props.generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {props.generating ? "生成中" : "AI 生图"}
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {props.mode === "other" ? (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03] md:px-5">
              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 dark:border-white/10 dark:bg-black/20">
                <button
                  type="button"
                  onClick={() => setOcrEngine("web")}
                  className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                    ocrEngine === "web"
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-950"
                      : "text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"
                  }`}
                >
                  Google 翻译
                </button>
                <button
                  type="button"
                  onClick={() => setOcrEngine("doubao")}
                  className={`h-8 rounded-md px-3 text-xs font-medium transition ${
                    ocrEngine === "doubao"
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-950"
                      : "text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"
                  }`}
                >
                  豆包网页版（免费）
                </button>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                目标语言
                <select
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value)}
                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-800 outline-none dark:border-white/10 dark:bg-black/20 dark:text-slate-100"
                >
                  <option value="ru">俄语</option>
                  <option value="en">英语</option>
                  <option value="es">西班牙语</option>
                  <option value="de">德语</option>
                </select>
              </label>
              <Button
                type="button"
                size="sm"
                className="h-9 gap-2 rounded-lg bg-blue-700 text-white hover:bg-blue-800"
                disabled={!props.ocrReady || !props.images.length || !props.onBatchTranslate || batchTranslating}
                onClick={() => {
                  if (!props.onBatchTranslate) return;
                  setBatchTranslating(true);
                  setEditorMessage(`正在将 ${props.images.length} 张图片拼成图集并提交 Google 翻译...`);
                  void props.onBatchTranslate(props.images, targetLanguage)
                    .then(() => {
                      setEditorMessage(`图集翻译完成，已裁剪并回填 ${props.images.length} 张图片`);
                    })
                    .catch((error) => {
                      setEditorMessage(error instanceof Error ? error.message : "图集批量翻译失败");
                    })
                    .finally(() => setBatchTranslating(false));
                }}
              >
                {batchTranslating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
                {batchTranslating ? "图集翻译中" : `Google 图集翻译 (${props.images.length})`}
              </Button>
              <span className="text-xs text-slate-500">
                {props.ocrReady ? editorMessage || "图片翻译服务已连接" : "图片翻译服务未连接，请先启动 8010 服务"}
              </span>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)]">
              <aside className="min-h-0 overflow-y-auto border-b border-slate-200 p-3 dark:border-white/10 lg:border-b-0 lg:border-r">
                {props.images.length ? (
                  <div className="grid grid-cols-3 gap-2 lg:grid-cols-2">
                    {props.images.map((image, index) => (
                      <SelectableImageCard
                        key={image.id}
                        image={image}
                        selected={selectedImage?.id === image.id}
                        primary={index === 0}
                        onSelect={() => setSelectedImageId(image.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-slate-300 px-4 text-center text-xs leading-5 text-slate-500 dark:border-white/15">
                    还没有图片，请先添加或采集图片
                  </div>
                )}
              </aside>

              <div className="min-h-[520px] bg-slate-100 dark:bg-black/30">
                {selectedImage && props.ocrReady ? (
                  <iframe
                    ref={editorRef}
                    src={editorUrl}
                    title="图片翻译编辑器"
                    className="h-full min-h-[520px] w-full border-0"
                    onLoad={() => setEditorReady(true)}
                  />
                ) : (
                  <div className="grid h-full min-h-[520px] place-items-center px-6 text-center text-sm text-slate-500">
                    {selectedImage ? "图片翻译编辑服务尚未就绪" : "选择一张其他图片开始修改"}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
