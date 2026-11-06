---
name: miro-recados
description: Integra um sistema do Jean (NestJS, Laravel, PHP legado, FastAPI/Python, Node) com os recados do Miro — o robô de mesa que repassa avisos de suporte, saúde e cadastro. Use quando pedirem para o sistema "avisar o Miro", "mandar recado pro Miro", "implantar os recados", ou ligar chamados de suporte, alertas de saúde e cadastros novos ao robô.
---

# Recados do Miro

O Miro (gateway em `~/Projects/Jean/robot_assistant`) recebe recados dos sistemas por HTTP e
decide quando contar ao Jean (chat, push no celular, balão na tela do robô). O sistema só precisa
mandar um POST — fora do fluxo da requisição, sem nunca falhar por causa do Miro.

## Contrato

```
POST {MIRO_RECADOS_URL}/api/recados
Authorization: Bearer {MIRO_RECADOS_CHAVE}
Content-Type: application/json
```

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `titulo` | string ≤ 120 | sim (menos com `resolvido`) | o que aparece primeiro: "Chamado novo: lote parado" |
| `texto` | string ≤ 2000 | não | detalhe; o Miro mostra ~280 caracteres |
| `tipo` | `suporte` · `saude` · `cadastro` · `outro` | não (`outro`) | |
| `prioridade` | `urgente` · `normal` · `baixa` | não (`normal`) | ver tabela abaixo |
| `link` | http(s) ≤ 500 | não | onde o Jean resolve (tela do admin) |
| `chave` | string ≤ 120 | recomendado | mesma chave = atualiza o recado aberto em vez de criar outro |
| `resolvido` | boolean | não | `true` + `chave` fecha o recado |

Respostas: `202 {"id","novo","aberto"}` · `400` corpo inválido · `401` chave errada ·
`403` sistema desativado no Miro · `429` mais de 60 recados/min. Nenhuma delas deve virar erro
para o usuário do sistema — só log de aviso.

### Prioridade: quem decide quando o Jean é interrompido

| Prioridade | O Miro faz | Use para |
|---|---|---|
| `urgente` | avisa na hora, a qualquer hora, furando a folga do fim de semana | sistema/fonte fora do ar, lote ou fila parados, erro que afeta todos os clientes |
| `normal` | avisa das 8h às 21h fora do silêncio combinado; senão guarda | chamado de suporte novo, resposta de cliente, falha pontual |
| `baixa` | só no bom-dia/fim do dia e quando o Jean pergunta | cadastro novo, assinatura, métricas, curiosidades |

Na dúvida, **normal**. Urgente demais vira ruído e ele para de ler.

### Chave: um recado por assunto, não por evento

- Chamado de suporte: `suporte:<id da conversa>` — cada mensagem nova do cliente atualiza o mesmo
  recado ("(3x)"), e o fechamento do chamado manda `resolvido: true`.
- Incidente de saúde: `saude:<o que caiu>` (ex.: `saude:fonte-sefaz`) — abre na falha, fecha com
  `resolvido: true` quando normaliza. O Miro só conta que normalizou se tinha avisado do problema.
- Cadastro: `cadastro:<id do usuário>`.
- Evento único sem continuação: pode omitir a chave.

### Saúde: o que NÃO precisa mandar

Se o sistema tem `/health`, o Jean cadastra a URL no app do Miro e o robô sonda a cada 2 min
(3 falhas = urgente "Fora do ar"). **Não implemente "estou fora do ar" de dentro do sistema** —
fora do ar ele não manda nada. De dentro, mande só o que a sonda não enxerga: fonte externa
falhando, lote com muita falha, fila parada, certificado vencendo, disco enchendo.

## Passo a passo

1. **Mapear antes de codar.** Procure onde o sistema já avisa alguém: e-mails para admin,
   notificações, mudanças de status de chamado, monitores de saúde, cadastro/registro. Ex.:
   `grep -rniE "admin|alerta|aviso|notif|suporte|chamado|registr|cadastr" src app`.
   Mostre ao Jean a lista de pontos com **tipo, prioridade e chave** de cada um e espere o ok —
   é ele quem decide o que merece interromper.

2. **Configuração.** Duas variáveis, documentadas no `.env.example` **vazias**:
   ```
   # Recados do Miro (Ajustes → Recados dos sistemas, no app do Miro). Vazio = desligado.
   MIRO_RECADOS_URL=https://srv1966497.hstgr.cloud
   MIRO_RECADOS_CHAVE=
   ```
   **Nunca gere, peça ou escreva a chave real.** O Jean cria o sistema no app do Miro
   (Ajustes → Recados dos sistemas → + Novo sistema), copia a chave (`rcd_…`, aparece uma vez) e
   cola ele mesmo no `.env` do servidor. Sem as duas variáveis, o cliente não faz nada.

3. **Cliente.** Copie o modelo da stack em `clientes/` (ao lado deste arquivo) e adapte ao estilo
   do projeto (nomes, logger, injeção, config). Regras que não mudam:
   - fora do fluxo da requisição (fire-and-forget / fila / `afterResponse`), timeout ≤ 5 s;
   - **nunca lança**: Miro fora do ar, 4xx ou 5xx viram um log de aviso, e só;
   - não loga a chave nem o corpo inteiro;
   - corta `titulo` (120) e `texto` (2000) antes de mandar;
   - desligado (sem URL ou chave) = não faz nada, sem log a cada chamada.

   | Stack | Modelo |
   |---|---|
   | NestJS / Node | `clientes/nestjs.ts` |
   | Laravel | `clientes/laravel.php` |
   | PHP legado (sem framework) | `clientes/php.php` |
   | FastAPI / Python / Celery | `clientes/python.py` |

4. **Ligar nos pontos** aprovados no passo 1, ao lado do aviso que já existe (e-mail etc.), sem
   trocar um pelo outro.

5. **Dados.** O recado vai para o servidor do Jean, mas mande o mínimo: nome do cliente e o
   assunto bastam. Nada de CPF/CNPJ completo, senha, token, conteúdo de XML/nota, dados bancários.

6. **Testes.** Cubra pelo menos: monta o corpo certo; com o Miro respondendo 500 ou sem rede, o
   fluxo principal continua e nada é lançado; sem configuração, não chama a rede.

7. **Teste ponta a ponta.** Com a chave no `.env` local, dispare o evento de verdade (ou peça ao
   Jean para rodar o `curl` abaixo) e confirme com ele que chegou no chat do Miro:
   ```bash
   curl -sS -X POST "$MIRO_RECADOS_URL/api/recados" \
     -H "Authorization: Bearer $MIRO_RECADOS_CHAVE" -H 'Content-Type: application/json' \
     -d '{"tipo":"outro","titulo":"Teste de integração","texto":"Se chegou, está ligado."}'
   ```
   Com o `.env` carregado o `curl` não expõe a chave na conversa — não a imprima nem a cole aqui.

8. **Deploy segue as regras do projeto.** Os sistemas da TAX e da Previnity são produção, e push na
   `main` da org New-Previnity dispara deploy: só commit/push quando o Jean pedir.
