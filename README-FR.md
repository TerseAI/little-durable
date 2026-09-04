# Little Durable - Un runtime d'exécution durable pour TypeScript en seulement 33 kB compressés

[![npm](https://img.shields.io/npm/v/little-durable)](https://www.npmjs.com/package/little-durable)
[![Taille npm décompressée](https://img.shields.io/npm/unpacked-size/little-durable)](https://npmx.dev/package/little-durable)
[![CI](https://github.com/TerseAI/little-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/TerseAI/little-durable/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Documentation](https://img.shields.io/badge/docs-lire-4B5563)](./Docs.md)
[![Licence : MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Slack](https://img.shields.io/badge/Slack-Rejoindre%20la%20communaut%C3%A9-4A154B?logo=slack&logoColor=white)](https://join.slack.com/t/tersecommunity/shared_invite/zt-3y01ap0bn-VvOqz~iJW0LbJ0cTqWuAIQ)

*Read this in [English](./README.md).*

Il s'agit d'un runtime de workflows durables extrêmement léger (33 kB compressés !), agnostique vis-à-vis du runtime et du stockage, et entièrement malléable.

Little Durable est BYOCP (bring your own control plane, oui, je viens tout juste d'inventer cet acronyme), BYOC et BYOS(torage).

Ce projet a été entièrement construit avec l'approche TDD + IA. Tout a commencé par des tests, et tout est massivement couvert par des tests unitaires.

# Installation

Little Durable nécessite Node.js 20 ou une version plus récente. Installez-le avec Zod :

```bash
npm install little-durable zod
```

Consultez le [projet d'exemple](./examples/order-approval) pour voir une véritable implémentation fonctionnelle de little-durable.

# Pourquoi ce projet existe-t-il ?

J'ai construit ce projet parce que je voulais exécuter des fonctions durables sur des Sandboxes. Cela impliquait de coupler l'état du système de fichiers avec le journal durable.

Les solutions existantes étaient très lourdes et faisaient des hypothèses sur la façon dont les workflows étaient hébergés. Par exemple, la plupart des systèmes de workflows durables supposent que vous exécutez tout sur un petit nombre de nœuds et que chaque invocation n'est pas isolée.

Ce n'est pas le cas lorsque l'on exécute de la durabilité dans un environnement serverless / de fonctions cloud.

Alors je l'ai créé !

Quelques fonctionnalités clés :

- Incroyablement léger : archive npm de 32,6 kB compressés avec seulement 2 dépendances d'exécution (ms et ulid)
- Agnostique vis-à-vis du stockage : le journal peut être Postgres, le système de fichiers, un Durable Object, etc.
- Agnostique vis-à-vis du runtime : fonctionne partout où vous pouvez importer ce paquet npm
- Sûreté de typage : la sûreté de typage est appliquée partout, avec Zod qui garantit la sûreté de la sérialisation dans les interactions avec le journal.

```ts
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileJournalStore, Runtime, defineWorkflow, sleep, step } from "little-durable"
import { z } from "zod"

// Initialisation du runtime en 1 ligne
const runtime = new Runtime({ journalStore: new FileJournalStore(await mkdtemp(join(tmpdir(), "little-durable-test-"))) })

// Construisez votre workflow
const WelcomeWorkflow = defineWorkflow({
    name: "welcome-customer",
    input: z.object({
        recipient: z.string(),
        name: z.string()
    }),
    run: async input => {
        const message = await step({
            name: "prepare-message",
            input: {
                name: input.name
            },
            run: async ({ name }) => {
                return `Welcome, ${name}!`
            }
        })

        await sleep("1 day")

        await step({
            name: "send-message",
            input: {
                recipient: input.recipient,
                message
            },
            run: async ({ recipient, message }) => {
                return { delivered: true }
            }
        })
    }
})

// exécutez-le
const events = runtime.start(WelcomeWorkflow, {
    runId: "run-123",
    input: {
        // ceci est typé de manière sûre !
        recipient: "ada@example.com",
        name: "Ada"
    }
})

for await (const event of events) {
    console.log(event)

    if (event.type === "runtime.suspended") {
        // Contactez votre control plane et planifiez la reprise de l'exécution.
        console.log("Workflow suspended", event.suspension)
    }
}
```

Nous proposons également quelques méthodes pratiques pour consulter l'état d'une exécution.

```ts
const run = await runtime.getRun({ runId: "run-123" })
// { runId: "run-123", workflowName: "welcome-customer", startedAt: "..." }

const suspension = await runtime.getSuspension({ runId: "run-123" })
// { waitId: "wait_01...", request: { type: "hook", name: "timer", payload: { wakeAt: "..." } } }
// ou undefined lorsqu'aucune attente non résolue n'existe
```

Voici l'essentiel d'un runtime durable. À partir de là, vous pouvez choisir où stocker le journal en implémentant simplement une interface et en la branchant. (Voir fileJournalStore.ts pour un exemple d'implémentation)

```ts
export interface JournalStore {
    list(params: ListJournalEventsParams): Promise<readonly JournalEvent[]>
    listByType(params: ListJournalEventsByTypeParams): Promise<readonly JournalEvent[]>
    get(params: GetJournalEventParams): Promise<JournalEvent | undefined>
    append(params: AppendJournalEventParams): Promise<JournalEvent>
    popStep(params: PopJournalStepParams): Promise<void>
}
```

Peu importe où vous l'exécutez ! Exécutez-le sur un pod k8s hébergé, sur des Workers, dans des sandboxes, etc.

Nous facilitons grandement le branchement à un control plane externe

```ts
// Le control plane vous contacte via HTTP, gRPC, CLI, etc.
const input = req.input
const runId = req.runId
const workflowName = req.workflowName

// résolvez le workflow, votre code ici
const workflow = fetchWorkflow(workflowName)

// Démarrez un workflow
const events = runtime.start(workflow, {
    runId,
    input: {
        // ceci est typé de manière sûre !
        recipient: "ada@example.com",
        name: "Ada"
    }
})

for await (const event of events) publishRuntimeEvent(event)

// Reprise après un sleep
const waitId = req.waitId

const resumedEvents = runtime.resumeTimer(workflow, {
    runId,
    waitId
})

for await (const event of resumedEvents) publishRuntimeEvent(event)
```

Le système de hooks est lui aussi extrêmement malléable. Il est très facile d'ajouter des étapes « human in the loop » via Slack ou e-mail et de se brancher sur un système d'intégration comme Composio.

```ts
const ApprovalHook = defineHook({
    name: "approval",
    request: z.object({
        message: z.string()
    }),
    resolution: z.object({
        approved: z.boolean(),
        approvedBy: z.string()
    })
})

const WelcomeWorkflow = defineWorkflow({
    name: "welcome-customer",
    input: z.object({
        recipient: z.string(),
        name: z.string()
    }),
    run: async input => {
        console.log("Pre approval")

        const approved = await waitFor(ApprovalHook, {
            // Le type correspondra à l'objet zod « resolution » ci-dessus !
            message: "Deploy to production?"
        })

        console.log("Post approval:", approved)
    }
})

let suspension
for await (const event of runtime.start(WelcomeWorkflow, {
    runId: "run-123",
    input: {
        recipient: "ada@example.com",
        name: "Ada"
    }
})) {
    if (event.type === "runtime.suspended") suspension = event.suspension
}

if (suspension) {
    for await (const event of runtime.resumeHook(ApprovalHook, {
        workflow: WelcomeWorkflow,
        runId: "run-123",
        waitId: suspension.waitId,
        resolution: {
            approved: true,
            approvedBy: "Ada"
        }
    })) {
        console.log(event)
    }
}
```

D'ailleurs, nous implémentons `sleep()` à l'aide d'un petit wrapper autour de `defineHook()`. C'est un bon exemple à consulter si vous souhaitez créer des hooks personnalisés.

Chez Terse, nous utilisons ce projet en interne pour alimenter nos fonctions durables. Nous utilisons le `FileJournalStore` pour stocker le journal sur le système de fichiers. À la suspension de la sandbox, il est capturé dans le snapshot.

Vous pouvez très facilement créer votre propre `JournalStore`. Stockez le journal dans Postgres, un Durable Object, etc. — tant que vous pouvez vous y connecter, cela fonctionnera !

Étant donné à quel point ce projet est malléable et léger, vous pouvez l'utiliser comme base pour construire votre propre API de workflows durables, comme nous l'avons fait chez Terse. C'est là toute sa beauté.

# Que prenons-nous en charge ?

Voici la liste des fonctionnalités de durabilité incontournables actuellement disponibles :

- Démarrage, reprise et nouvelle tentative d'un workflow
- Journalisation des étapes
- Prise en charge de `step()` pour définir des étapes durables
- Passage d'un contexte de workflow et lecture de celui-ci depuis le workflow
- Fixation de `Date()` et générateur de nombres aléatoires avec graine pour des rejeux idempotents (utilise le `runId` comme graine)
- Création de hooks personnalisés pour suspendre et reprendre avec des données externes

# Documentation

Lisez la [documentation complète](./Docs.md).

# Projet d'exemple

Consultez le [workflow d'approbation de commande](./examples/order-approval) exécutable, qui illustre les étapes durables, les hooks typés, la journalisation sur le système de fichiers, la reprise indépendante du processus et la sûreté du rejeu.

# Communauté

[Rejoignez la communauté Slack de Terse](https://join.slack.com/t/tersecommunity/shared_invite/zt-3y01ap0bn-VvOqz~iJW0LbJ0cTqWuAIQ) pour poser vos questions, partager vos retours et nous montrer ce que vous construisez.
