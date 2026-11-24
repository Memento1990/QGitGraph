<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
const props = withDefaults(defineProps<{ modelValue: number; min: number; max: number; axis?: 'x' | 'y'; reverse?: boolean; label: string; owner?: string | number; step?: number }>(), { axis: 'x', reverse: false, step: 8 });
const emit = defineEmits<{ 'update:modelValue': [value: number]; change: [value: number] }>();
let active: { id: number; origin: number; value: number; owner: string | number | undefined } | null = null;
let last = props.modelValue;
function bounded(value: number) { return Math.max(props.min, Math.min(props.max, Math.round(value))); }
function update(value: number) { last = bounded(value); emit('update:modelValue', last); }
function detach() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', cancel); active = null; }
function move(event: PointerEvent) { if (!active || event.pointerId !== active.id || props.owner !== active.owner) return; update(active.value + ((props.axis === 'x' ? event.clientX : event.clientY) - active.origin) * (props.reverse ? -1 : 1)); }
function end(event: PointerEvent) { if (!active || event.pointerId !== active.id) return; move(event); detach(); emit('change', last); }
function cancel() { detach(); }
function start(event: PointerEvent) { if (event.button !== 0) return; event.preventDefault(); (event.currentTarget as HTMLElement).focus({ preventScroll: true }); detach(); last = props.modelValue; active = { id: event.pointerId, origin: props.axis === 'x' ? event.clientX : event.clientY, value: props.modelValue, owner: props.owner }; document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', cancel); }
function key(event: KeyboardEvent) { const smaller = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp'; const larger = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown'; if (![smaller, larger, 'Home', 'End'].includes(event.key)) return; event.preventDefault(); if (event.key === 'Home') update(props.min); else if (event.key === 'End') update(props.max); else update(props.modelValue + (event.key === larger ? 1 : -1) * (props.reverse ? -1 : 1) * props.step * (event.shiftKey ? 5 : 1)); emit('change', last); }
watch(() => props.owner, cancel, { flush: 'sync' });
onBeforeUnmount(cancel);
</script>
<template><div :class="['size-handle', axis]" role="separator" tabindex="0" :aria-label="label" :aria-orientation="axis === 'x' ? 'vertical' : 'horizontal'" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="Math.round(modelValue)" @pointerdown="start" @keydown="key"></div></template>
<style scoped>.size-handle{flex-shrink:0;position:relative;background:var(--line);outline-offset:-1px;touch-action:none}.size-handle.x{width:5px;cursor:col-resize}.size-handle.y{height:5px;cursor:row-resize}.size-handle:hover,.size-handle:focus-visible{background:var(--brand)}</style>
