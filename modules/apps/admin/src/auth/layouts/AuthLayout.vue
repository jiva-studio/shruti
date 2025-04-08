<template>
  <div
    class="flex h-screen items-center justify-center bg-gray-100 dark:bg-gray-900"
  >
    <div
      class="flex w-96 flex-col rounded-lg bg-white p-6 shadow-md dark:bg-black"
    >
      <p class="mb-6 text-center text-2xl font-bold">
        <!-- <img
          src="/src/assets/logo.png"
          alt="Logo"
          class="w-16 h-16 mx-auto mb-4"
        > -->
        <span class="text-blue-500 dark:text-blue-500">Lectorium</span>
      </p>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts"></script>
