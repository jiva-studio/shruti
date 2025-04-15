<template>
  <IonModal
    :is-open="open"
    @did-dismiss="open = false"
  >
    <IonContent :fullscreen="true">
      <slot />
      <p class="ion-padding prompter">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec tincidunt eleifend placerat. Etiam ac risus orci. Suspendisse sed maximus eros. Nullam quis leo a nunc fringilla viverra quis eget ex. Donec varius finibus ante sed semper. Praesent ut lectus vel elit maximus efficitur quis sed sem. Vivamus consectetur turpis in orci lacinia, consequat interdum risus ultricies. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Integer volutpat lectus et sem aliquam, non ultricies risus aliquet. Etiam neque orci, consectetur sed semper ut, malesuada vitae odio. In hendrerit fringilla pellentesque. Vivamus sagittis venenatis placerat. Vestibulum tincidunt elementum ipsum, non aliquam diam laoreet malesuada. Praesent ut massa justo. Nunc dapibus risus ut augue iaculis, sit amet rutrum est faucibus.

        Praesent non venenatis tellus, sit amet mattis libero. In id eros ultricies, suscipit purus quis, viverra velit. Mauris suscipit tellus ac odio efficitur, nec maximus ex dignissim. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Integer pulvinar nisl velit, quis mollis tellus consequat ut. Nulla scelerisque ipsum ut est consectetur, lobortis fringilla nulla rhoncus. Ut pharetra dui dolor, id eleifend tortor tincidunt vitae. Sed venenatis euismod sapien, eget gravida lacus dictum a. Ut nec dictum ex. Sed rutrum laoreet tortor, sit amet tempor elit cursus ut. Nullam id mollis sem. Etiam in lacus sagittis, rutrum augue at, pellentesque dolor. Morbi quis gravida sapien.

        Praesent non purus odio. Quisque faucibus sodales dictum. Vivamus rutrum enim vitae purus mollis, et hendrerit dui laoreet. Proin varius leo eget dui ullamcorper dictum. Quisque lobortis bibendum vulputate. Etiam sed vehicula mi. Phasellus ultrices risus sed mauris finibus, quis auctor dui faucibus. Suspendisse non lacus lectus. Vivamus libero libero, congue in placerat at, consectetur sit amet risus. Morbi sollicitudin a elit id commodo. Morbi scelerisque, nisi finibus facilisis sodales, ipsum risus commodo magna, sit amet pulvinar quam nisi nec nibh. Phasellus in nunc ac turpis mollis blandit ut in elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit.

        Vestibulum eleifend et dolor sed condimentum. Praesent a purus a dui dapibus imperdiet. Suspendisse id tincidunt odio, sed tincidunt augue. Maecenas felis sem, varius non fringilla elementum, molestie vel turpis. Sed lectus tortor, lacinia eu blandit sit amet, facilisis et purus. Cras eu lorem rutrum, auctor velit sed, molestie sapien. Curabitur tincidunt suscipit libero sit amet interdum. Morbi lorem nulla, tempus quis metus et, vulputate interdum felis. Quisque et aliquet tellus. Nunc porta ipsum nec tortor ornare, eu consequat orci accumsan. Quisque eu venenatis orci. Donec metus sapien, scelerisque eu tempor quis, ultricies quis arcu. Ut gravida augue eu quam porta semper. Nunc commodo metus ac odio faucibus, finibus pharetra tellus elementum.

        Nulla facilisi. Nullam at pulvinar enim, et aliquam diam. Nullam sagittis dapibus libero quis viverra. Suspendisse et porttitor nulla. Sed sed nibh vitae nulla aliquam interdum non at massa. Praesent tincidunt varius tristique. Aenean pretium quam et libero facilisis venenatis. Donec vel accumsan tellus. Nunc eleifend erat non enim pretium, sed hendrerit magna commodo. Aliquam quis arcu vitae metus aliquam molestie at sollicitudin sem. Suspendisse vel porta leo. Pellentesque at laoreet purus. Duis vulputate enim sed mauris fermentum, sit amet ultrices diam pharetra. Aliquam tristique mauris ipsum, vel dapibus est vehicula quis.
      </p>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonContent} from '@ionic/vue'

const open = defineModel<boolean>('open')
</script>


<style scoped>
ion-modal ion-content {
  --background: #1D263B;
}

ion-modal ion-toolbar {
  --background: #1D263B;
}

.prompter {
  color: white;
}
</style>