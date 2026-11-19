// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-friendly signature pad dialog with Draw canvas and Be Vietnam Pro typed signature tabs (#3325).
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import {
  hasSubstantiveSignatureStrokes,
  renderStrokesToCanvas,
  SIGNATURE_CANVAS_HEIGHT,
  SIGNATURE_CANVAS_WIDTH,
  strokesToPngDataUrl,
  typedTextToPngDataUrl,
  type SignaturePoint,
  type SignatureStroke,
} from '../../lib/sign-signature.ts';

export interface SignaturePadModalProps {
  open: boolean;
  defaultName?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: { pngDataUrl: string; kind: 'drawn' | 'typed'; typedText?: string }) => void;
}

export function SignaturePadModal({ open, defaultName = '', onOpenChange, onConfirm }: SignaturePadModalProps) {
  const t = useTranslations('sign.ceremony');
  const common = useTranslations('common');
  const [tab, setTab] = useState<'draw' | 'type'>('draw');
  const [strokes, setStrokes] = useState<SignatureStroke[]>([]);
  const [typedName, setTypedName] = useState(defaultName);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingStrokeRef = useRef<SignaturePoint[] | null>(null);

  useEffect(() => {
    if (open && !typedName && defaultName) {
      setTypedName(defaultName);
    }
  }, [open, defaultName, typedName]);

  useEffect(() => {
    if (!open || tab !== 'draw' || !canvasRef.current) return;
    renderStrokesToCanvas(canvasRef.current, strokes, {
      width: SIGNATURE_CANVAS_WIDTH,
      height: SIGNATURE_CANVAS_HEIGHT,
    });
  }, [open, tab, strokes]);

  const toCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>): SignaturePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = rect.width > 0 ? SIGNATURE_CANVAS_WIDTH / rect.width : 1;
    const scaleY = rect.height > 0 ? SIGNATURE_CANVAS_HEIGHT / rect.height : 1;
    return {
      x: Math.max(0, Math.min(SIGNATURE_CANVAS_WIDTH, (event.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(SIGNATURE_CANVAS_HEIGHT, (event.clientY - rect.top) * scaleY)),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toCanvasPoint(event);
    const nextStroke: SignaturePoint[] = [point];
    drawingStrokeRef.current = nextStroke;
    setStrokes((prev) => [...prev, nextStroke]);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingStrokeRef.current) return;
    const point = toCanvasPoint(event);
    drawingStrokeRef.current.push(point);
    const current = drawingStrokeRef.current;
    setStrokes((prev) => [...prev.slice(0, -1), [...current]]);
  };

  const finishStroke = () => {
    drawingStrokeRef.current = null;
  };

  const canConfirm = tab === 'draw' ? hasSubstantiveSignatureStrokes(strokes) : typedName.trim().length > 0;

  const handleConfirm = () => {
    if (tab === 'draw') {
      const pngDataUrl = strokesToPngDataUrl(strokes);
      if (!pngDataUrl) return;
      onConfirm({ pngDataUrl, kind: 'drawn' });
      onOpenChange(false);
      return;
    }
    const pngDataUrl = typedTextToPngDataUrl(typedName);
    if (!pngDataUrl) return;
    onConfirm({ pngDataUrl, kind: 'typed', typedText: typedName.trim() });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{t('padTitle')}</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(next) => setTab(next as 'draw' | 'type')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="draw" className="min-h-10">
              {t('tabDraw')}
            </TabsTrigger>
            <TabsTrigger value="type" className="min-h-10">
              {t('tabType')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="draw" className="mt-3 space-y-2">
            <div className="overflow-hidden rounded-lg border border-field-border bg-image-surface">
              <canvas
                ref={canvasRef}
                data-testid="signature-draw-canvas"
                width={SIGNATURE_CANVAS_WIDTH}
                height={SIGNATURE_CANVAS_HEIGHT}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishStroke}
                onPointerCancel={finishStroke}
                className="h-44 w-full touch-none select-none"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('drawHint')}</p>
              <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => setStrokes([])}>
                {t('clearPad')}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="type" className="mt-3 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="typed-signature-input">{t('typeLabel')}</Label>
              <Input
                id="typed-signature-input"
                className="min-h-11"
                placeholder={t('typePlaceholder')}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
              />
            </div>
            <div className="flex h-32 items-center justify-center rounded-lg border border-field-border bg-muted/30 px-4">
              <span className="truncate text-3xl font-semibold italic text-foreground">
                {typedName.trim() || t('typePlaceholder')}
              </span>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            {common('cancel')}
          </Button>
          <Button type="button" className="min-h-11" disabled={!canConfirm} onClick={handleConfirm} data-testid="signature-pad-apply">
            {t('applySignature')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
