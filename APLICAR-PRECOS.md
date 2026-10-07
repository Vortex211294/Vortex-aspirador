# Preços por equipamento

A migração `supabase/04_precos_equipamento.sql` já foi aplicada conforme o resultado informado, e a geração de PIX com preços e durações variados foi testada no Sandbox.

No app, selecione o equipamento, ajuste os valores e clique em **Salvar preços e tempo do equipamento** antes de gerar o QR Code. No modo por minutos, R$1/min × 3 minutos = R$3; R$5/min × 3 minutos = R$15. O pacote fixo mantém valor e tempo próprios. Recarregue a página para conferir os valores salvos.

O proprietário ativo altera seus equipamentos; a Central tem acesso geral. PIX anteriores conservam seu valor e seus minutos. O pagamento confirmado depende do controlador para acionar o equipamento físico.

Para o estado completo da atualização, implantação e testes, consulte `README.md`.
