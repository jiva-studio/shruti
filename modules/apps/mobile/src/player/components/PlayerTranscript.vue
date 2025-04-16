<template>
  <IonModal
    :is-open="open"
    @did-dismiss="open = false"
  >
    <IonContent
      :fullscreen="true"
      class="ion-padding"
    >
      <slot />
      <p
        v-for="t in text"
        :key="t.timestamp"
        class="prompter"
      >
        {{ t.text }}
      </p>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { IonModal, IonContent} from '@ionic/vue'

const open = defineModel<boolean>('open')

const text = [
  {
    timestamp: 0,
    text: 'Ladies and gentlemen, devotees and seekers, please accept my humble obeisances. All glories to Śrīla Prabhupāda. All glories to Śrī Kṛṣṇa, the Supreme Personality of Godhead.'
  },
  {
    timestamp: 0,
    text: 'So, who is Kṛṣṇa? Kṛṣṇa is not an ordinary person. He is Bhagavān, the Supreme Personality of Godhead. In the Bhagavad-gītā, Kṛṣṇa says, \'mattaḥ parataraṁ nānyat kiñcid asti dhanañjaya\' – there is no truth superior to Me. He is the cause of all causes, sarva-kāraṇa-kāraṇam.'
  },
  {
    timestamp: 0,
    text: 'When we speak of God, we must understand what that means. Not a vague idea. No. God is a person, and His name is Kṛṣṇa. He has a form, He has qualities, and He performs activities—divine pastimes, or līlās—and all of them are transcendental.'
  },
  {
    timestamp: 0,
    text: 'In the material world, we are trying to enjoy, but we are frustrated. Why? Because we are not the enjoyer—we are the enjoyed. The real enjoyer is Kṛṣṇa. We are His eternal servants. That is our natural position: jīvera \'svarūpa\' haya — kṛṣṇera \'nitya-dāsa\'.'
  },
  {
    timestamp: 0,
    text: 'Kṛṣṇa comes to this world not to become God—He is always God. He comes to attract us back to Him. Therefore, He speaks the Bhagavad-gītā. He says, \'sarva-dharmān parityajya mām ekaṁ śaraṇaṁ vraja\' – Just surrender unto Me.'
  }, 
  {
    timestamp: 0,
    text: 'And when we chant the holy name – Hare Kṛṣṇa, Hare Kṛṣṇa, Kṛṣṇa Kṛṣṇa, Hare Hare / Hare Rāma, Hare Rāma, Rāma Rāma, Hare Hare – we are calling out to Kṛṣṇa and His internal energy, Śrīmatī Rādhārāṇī. This chanting is the yuga-dharma, the process of self-realization for this age of Kali.'
  } ,{
    timestamp: 0,
    text: 'So please, do not take Kṛṣṇa as some mythology or symbol. He is a historical person, appeared 5,000 years ago in Mathurā, performed wonderful pastimes in Vṛndāvana, and gave His transcendental teachings in Kurukṣetra.'
  },
  {
    timestamp: 0,
    text: 'Take to Kṛṣṇa consciousness seriously. Read Bhagavad-gītā As It Is, chant the holy name, and associate with devotees. Then your life will become successful. This human life is meant for understanding Kṛṣṇa. Otherwise, we are simply wasting time.'
  },
  {
    timestamp: 0,
    text: 'Thank you very much. Hare Kṛṣṇa.'
  }
]
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