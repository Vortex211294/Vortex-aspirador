# VORTEX ASPIRADOR

Painel de autoatendimento com GitHub Pages, Supabase e integração PIX PagBank em Sandbox. Mantém o visual azul/preto e o acesso da Central e dos clientes.

## Estado da atualização — 07/10/2026

O app é publicado pelo GitHub Pages a partir de `main`. Esta revisão adiciona cadastro do controlador/firmware e gráficos com dias na horizontal e horários de pagamentos na vertical.

- Preços por equipamento: pacote fixo tem valor e duração próprios; cobrança por minutos usa preço salvo × minutos da compra. Central e proprietário ativo podem salvar a configuração. O servidor confere o preço e preserva a duração de pagamentos anteriores.
- Mensalidade: a tela mostra primeiro a dívida vencida mais antiga; sem dívida vencida, mostra a última mensalidade paga e informa a próxima cobrança separadamente. Exibe quanto já foi descontado e quanto falta.
- PIX: a criação e o webhook usam Sandbox. O webhook consulta o pedido autenticadamente no PagBank, confere valor e moeda, preserva pagamentos confirmados contra eventos atrasados e evita processamento repetido na atualização do status.
- Comando: o painel distingue a duração do comando da duração do pacote configurado. O envio do comando e o status PAID não comprovam acionamento físico.

## Arquivos

| Caminho | Finalidade |
|---|---|
| `index.html` | App servido pelo GitHub Pages |
| `supabase/01_recebimento.sql` | Gravação e leitura dos dados de recebimento por conta |
| `supabase/02_diagnostico.sql` | Consulta de estrutura e permissões |
| `supabase/03_acionamento.sql` | Acionamento remoto com autorização |
| `supabase/04_precos_equipamento.sql` | Preços e tempo configuráveis por equipamento |
| `supabase/05_comando_pix_data.sql` | Data de envio do comando associado ao PIX |
| `supabase/06_diagnostico_mensalidade.sql` | Diagnóstico financeiro sem listar dados pessoais |
| `supabase/06b_permissoes_agendamento.sql` | Restrição das chamadas internas de cobrança |
| `supabase/07_mensalidades_30_dias.sql` | Ciclos de 30 dias, bloqueio por cliente e cobrança parcial |
| `supabase/08_primeiros_recebimentos_mensalidade.sql` | Primeira mensalidade desde o cadastro; primeiros recebimentos líquidos cobrem R$50 |
| `supabase/09_dados_controlador.sql` | Cadastro manual protegido por proprietário/Central |
| `supabase/functions/` | Código das duas Edge Functions PIX em Sandbox |
| `tests/` | Testes da interface, PIX, webhook e mensalidades |

## Mensalidade e implantação

As migrações de recebimento, acionamento, preços, comando PIX e permissões foram executadas conforme os resultados informados. A migração 07 também foi aplicada: o job de mensalidades ficou em `15 * * * *`, e o job de verificação de offline foi preservado em `* * * * *`.

**A regra da migração 08 foi conferida diretamente no Supabase em 07/10/2026.** A primeira mensalidade começa no cadastro, e o ciclo de 30 dias está ativo. Ter o arquivo no GitHub não executa SQL nem publica Edge Functions no Supabase. O ajuste 08 deve ser executado depois de 07. Não reaplicar 07 depois de 08, pois a primeira cobrança de 08 substitui o período inicial gratuito da versão anterior.

O ajuste 08 usa os primeiros recebimentos líquidos, após a comissão de 2,99%, para completar R$50 de mensalidade antes de disponibilizar saldo para repasse. Preserva ciclos já quitados e o histórico financeiro; não cobra outra vez uma mensalidade já paga. A próxima cobrança fica 30 dias depois. Novos clientes ativos que não sejam administradores iniciam a primeira cobrança no cadastro.

Clientes com cobranças já registradas preservam suas datas. Para clientes sem cobrança anterior nem desconto, o ajuste antecipa apenas a primeira mensalidade futura para a data de aplicação. Mais de uma cobrança futura ambígua provoca rollback para revisão, sem alteração parcial.

O registro de repasse no banco não realiza transferência bancária. Credenciais PagBank e chave de serviço ficam somente nos secrets do Supabase, nunca neste repositório.

## Validação

70 testes passaram, sem falhas ou testes ignorados, usando Node e PostgreSQL 18.3 embarcado pelo PGlite 0.5.8. Os testes de interface e PIX simulam o banco e o provedor; os testes de assinatura geram chaves ECDSA locais. O agendamento pg_cron é simulado nos testes SQL. O job real de mensalidade foi conferido com execução bem-sucedida. Concorrência entre conexões ainda precisa de teste dedicado.

Para reproduzir em um ambiente de testes:

```sh
npm install --no-save @electric-sql/pglite@0.5.8
node --test tests/*.test.cjs
```

Sem PGlite, os testes SQL são explicitamente ignorados. Os testes não fazem pagamentos reais, transferências nem acionam motores.

## Pendências externas ao GitHub

- Completar a validação de produção do PagBank; os pagamentos atuais permanecem em Sandbox.
- Validar permissões RLS e isolamento entre contas no projeto real.
- Integrar controlador físico, heartbeat, temporizador e confirmação de término; o equipamento ainda não tem controlador.
- Implementar o serviço de notificações automáticas. As preferências atuais ficam neste navegador.
- Validar homologação e credenciais de produção PagBank antes de cobranças reais. Os testes atuais são Sandbox.
- Implementar reconciliação persistente para falhas que excedam as retentativas do provedor e tratar devoluções.


Atualização 07/10/2026: cadastro de modelo, serial, SSID, IP, MAC, versão, URL HTTPS e SHA-256 do firmware por equipamento (09_dados_controlador.sql). Dados manuais persistem no Supabase com acesso do proprietário/Central; o cadastro não instala firmware. Gráficos mostram horários de pagamentos PAID em Brasília na vertical e dias da semana na horizontal; valores e minutos ficam nos detalhes dos pontos.
