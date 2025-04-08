<template>
  <div class="root">
    <slot name="menu" />
    <div class="content">
      <slot name="main" />
    </div>
  </div>
</template>

<style scoped>
.root {
  margin: 1rem;
}

.content {
  margin-top: 1rem;
}
</style>
