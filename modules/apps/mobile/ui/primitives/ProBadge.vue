<template>
  <span class="pro-badge">{{ $t("app.proBadge") }}</span>
</template>

<style scoped>
.pro-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  vertical-align: middle;
  line-height: 1.3;
}
</style>
